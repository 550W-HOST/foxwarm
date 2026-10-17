import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile, mkdir } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import { webuiReactAliases } from './reactRendererAliases.mjs'
import puppeteer from 'puppeteer-core'

let browser, server, baseUrl
before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const bundle = await build({
    stdin: { contents: `
      import React, { StrictMode, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import ProcessingStatus, { QueuedMessageStatus } from './src/components/ProcessingStatus'
      import { initializeThemeRuntime } from './src/theme'
      initializeThemeRuntime()
      function Fixture() {
        const [state, setState] = useState('requesting-model')
        const [queue, setQueue] = useState(0)
        window.fixture.setQueue = setQueue
        window.fixture.setState = setState
        return <><ProcessingStatus sessionBusy={state !== 'idle'} sessionQueueLength={queue} turnIncomplete={state === 'interrupted'} timelineView="grouped"
          loading={state === 'loading'} isMobile={innerWidth < 768}
          runtimeState={{state: state === 'interrupted' ? 'idle' : state === 'compacting' ? 'requesting-model' : state === 'exec' ? 'running-tool' : state,
            active: {phase: state === 'compacting' ? 'compaction' : 'normal-turn'},
            tool: {name: state === 'exec' ? 'exec' : 'read', index: 0, total: 2, executionNode: 'fixture-node', argsPreview: 'echo WORK', startedAt: 1}}}
          onContinue={() => window.fixture.continues++} onStop={() => window.fixture.stops++} />
          <QueuedMessageStatus count={queue} alignment="left" isMobile={innerWidth < 768} onRunQueued={() => window.fixture.runs++} /></>
      }
      window.fixture = {stops: 0, runs: 0, continues: 0}
      createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>)
    `, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'thinking-fixture.tsx', loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    alias: webuiReactAliases, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}body{padding:16px}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
})
after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

async function open({ width = 900, reduced = false } = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 500 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }])
  await page.evaluateOnNewDocument(() => {
    Math.random = () => 0
    const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window)
    window.thinkingTimers = new Set()
    window.setTimeout = (fn, ms, ...args) => {
      const id = set(() => { window.thinkingTimers.delete(id); fn(...args) }, ms)
      if (ms >= 5000 && ms <= 7000 || ms === 450) window.thinkingTimers.add(id)
      return id
    }
    window.clearTimeout = id => { window.thinkingTimers.delete(id); clear(id) }
  })
  await page.goto(baseUrl)
  await page.waitForSelector('[data-thinking-phrase="initial"]')
  return page
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect()
      return { x, y, width, height }
    }
    return { badge: box('[data-processing-runtime-state]'), slot: box('[data-processing-status-slot]') }
  })
}

test('fox highlight holds between steps without changing loop speed', async () => {
  const page = await open()
  try {
    const progression = await page.$eval('.fw-fox-comet', element => {
      const animation = element.getAnimations()[0]
      animation.pause()
      const offsetAt = time => {
        animation.currentTime = time
        return getComputedStyle(element).strokeDashoffset
      }
      return {
        duration: animation.effect.getTiming().duration,
        start: offsetAt(0),
        withinStep: offsetAt(35),
        nextStep: offsetAt(105),
      }
    })
    assert.equal(progression.duration, 1400)
    assert.equal(progression.start, progression.withinStep)
    assert.notEqual(progression.start, progression.nextStep)
  } finally { await page.close() }
})

test('phrases wipe and resize without moving text or rendering a runtime Stop action', async () => {
  const page = await open()
  try {
    const before = await geometry(page)
    const style = await page.$eval('.fw-processing-badge', element => {
      const style = getComputedStyle(element)
      return { border: style.borderTopWidth, background: style.backgroundColor, font: getComputedStyle(element.querySelector('[data-fox-thinking-copy]')).fontSize }
    })
    assert.deepEqual(style, { border: '0px', background: 'rgba(0, 0, 0, 0)', font: '18px' })
    assert.equal(await page.$eval('.fw-fox-thinking-phrases', element => parseFloat(getComputedStyle(element).lineHeight) / parseFloat(getComputedStyle(element).fontSize)), 1.5)
    await page.waitForSelector('[data-thinking-phrase="outgoing"]')
    const layers = await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        if (animation.animationName?.startsWith('fw-fox-copy-')) animation.currentTime = 225
      }
      return [...document.querySelectorAll('[data-thinking-phrase]')].map(element => ({
        text: element.textContent, opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform, clip: getComputedStyle(element).clipPath,
      }))
    })
    assert.equal(layers.length, 2)
    assert.notEqual(layers[0].text, layers[1].text)
    assert.ok(layers.every(layer => layer.opacity === 1 && layer.clip.startsWith('inset(')))
    assert.ok(layers.every(layer => layer.transform === 'none'))
    assert.notEqual(layers[0].clip, layers[1].clip)
    const middle = await geometry(page)
    assert.equal(middle.badge.x, before.badge.x)
    assert.equal(middle.slot.height, before.slot.height)
    assert.equal(await page.$eval('[data-fox-thinking-copy]', element => element.getAnimations().some(animation => animation.transitionProperty === 'width')), true)
    assert.equal(await page.$eval('[data-fox-thinking-copy] .sr-only', element => element.textContent), 'Thinking...')
    assert.equal(await page.$eval('.fw-fox-thinking-phrases', element => element.getAttribute('aria-hidden')), 'true')
    await page.waitForFunction(() => {
      const copy = document.querySelector('[data-fox-thinking-copy]')
      return !copy.querySelector('[data-thinking-phrase="outgoing"]') && Math.abs(copy.getBoundingClientRect().width - Math.ceil(copy.querySelector('.fw-fox-thinking-measure').getBoundingClientRect().width)) < 0.5
    })
    const after = await geometry(page)
    assert.ok(after.badge.width < before.badge.width, 'shorter phrases use less space')
    assert.equal(await page.$('.fw-processing-main > button'), null)
    assert.equal(after.slot.height, before.slot.height)
  } finally { await page.close() }
})

test('reduced motion changes copy without animation or duplicate visible layers', async () => {
  const page = await open({ reduced: true })
  try {
    assert.equal(await page.$eval('.fw-fox-comet', element => getComputedStyle(element).animationName), 'none')
    await page.waitForSelector('[data-thinking-phrase="outgoing"]')
    assert.equal(await page.$eval('[data-thinking-phrase="outgoing"]', element => getComputedStyle(element).display), 'none')
    const style = await page.$eval('[data-thinking-phrase="incoming"]', element => {
      const style = getComputedStyle(element)
      return { animation: style.animationName, transform: style.transform, opacity: style.opacity }
    })
    assert.deepEqual(style, { animation: 'none', transform: 'none', opacity: '1' })
  } finally { await page.close() }
})

test('narrow caption-only rows preserve fixed status height and timer cleanup across real states', async () => {
  const page = await open({ width: 240 })
  try {
    const boxes = await geometry(page)
    assert.equal(boxes.slot.height, 56)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    for (const state of ['compacting', 'running-tool', 'waiting', 'loading', 'idle']) {
      await page.evaluate(state => window.fixture.setState(state), state)
      await page.waitForFunction(() => !document.querySelector('[data-fox-thinking-copy]') && window.thinkingTimers.size === 0)
      assert.equal(await page.$eval('[data-processing-status-slot]', element => element.getBoundingClientRect().height), 56)
      if (state === 'loading' || state === 'idle' || state === 'waiting') assert.equal(await page.$('button'), null)
    }
  } finally { await page.close() }
})


test('exec gets borderless action copy, distinct semantic color, and real details without a tag', async () => {
  const page = await open()
  try {
    const thinking = await page.$eval('[data-fox-thinking-copy]', element => getComputedStyle(element).color)
    await page.evaluate(() => window.fixture.setState('exec'))
    await page.waitForSelector('[data-fox-copy-mode="exec"]')
    const exec = await page.$eval('[data-fox-thinking-copy]', element => getComputedStyle(element).color)
    assert.notEqual(exec, thinking)
    assert.equal(await page.$eval('[data-processing-runtime-state]', element => getComputedStyle(element).borderTopWidth), '0px')
    assert.match(await page.$eval('[data-fox-copy-mode="exec"]', element => element.textContent), /Prowling through the pines/)
    assert.equal(await page.$eval('.fw-processing-exec .fw-fox', element => getComputedStyle(element).stroke), exec)
    assert.match(await page.$eval('[title*="echo WORK"]', element => element.title), /tool: exec 1\/2.*fixture-node.*echo WORK/)
    assert.equal(await page.$eval('[data-fox-copy-mode="exec"] .sr-only', element => element.textContent), 'tool: exec 1/2')
    assert.equal(await page.$('[data-processing-tool-tag]'), null)
    assert.equal(await page.evaluate(() => window.thinkingTimers.size), 1)
    await page.evaluate(() => window.fixture.setState('requesting-model'))
    await page.waitForFunction(() => document.querySelector('[data-fox-copy-mode="thinking"]') && window.thinkingTimers.size === 1)
    assert.equal(await page.$eval('[data-fox-thinking-copy] .sr-only', el => el.textContent), 'Thinking...')
    assert.match(await page.$eval('[data-thinking-phrase]', el => el.textContent), /Negotiating with squirrels/)
    await page.evaluate(() => window.fixture.setState('exec'))
    await page.waitForFunction(() => document.querySelector('[data-fox-copy-mode="exec"]') && window.thinkingTimers.size === 1)
    assert.match(await page.$eval('[data-thinking-phrase]', el => el.textContent), /Prowling through the pines/)
    await page.evaluate(() => window.fixture.setState('idle'))
    await page.waitForFunction(() => window.thinkingTimers.size === 0)
  } finally { await page.close() }
})


test('all runtime states and queue copy are borderless, with smaller muted queue metadata', async () => {
  const page = await open()
  try {
    for (const state of ['requesting-model', 'exec', 'compacting', 'running-tool', 'waiting']) {
      await page.evaluate(state => window.fixture.setState(state), state)
      await page.waitForFunction(state => document.querySelector('[data-processing-runtime-state]')?.dataset.processingRuntimeState === (state === 'exec' ? 'running-tool' : state === 'compacting' ? 'requesting-model' : state), {}, state)
      assert.deepEqual(await page.$eval('.fw-processing-badge', element => {
        const css = getComputedStyle(element)
        return {border: css.borderTopWidth, background: css.backgroundColor}
      }), {border: '0px', background: 'rgba(0, 0, 0, 0)'})
      assert.equal(await page.$$eval('button', buttons => buttons.every(button => getComputedStyle(button).borderTopWidth === '0px')), true)
    }
    await page.evaluate(() => window.fixture.setQueue(2))
    await page.waitForSelector('[data-processing-queue-status]')
    const metadata = await page.$eval('[data-processing-queue-status]', element => {
      const style = getComputedStyle(element)
      const expected = document.createElement('span')
      expected.className = 'text-fw-text-muted'
      document.body.append(expected)
      const muted = getComputedStyle(expected).color
      expected.remove()
      return {size: style.fontSize, color: style.color, muted, border: style.borderTopWidth, background: style.backgroundColor,
        left: Math.abs(element.getBoundingClientRect().left - document.querySelector('[data-processing-queue-footer]').getBoundingClientRect().left) < 1}
    })
    assert.equal(metadata.size, '12px')
    assert.equal(metadata.color, metadata.muted)
    assert.equal(metadata.border, '0px')
    assert.equal(metadata.background, 'rgba(0, 0, 0, 0)')
    assert.equal(metadata.left, true)
    await page.click('[data-processing-queue-status] button')
    assert.equal(await page.evaluate(() => window.fixture.runs), 1)
  } finally { await page.close() }
})


test('short queued count and real actions remain visible in wide and narrow states', async () => {
  for (const width of [900, 240]) {
    const page = await open({ width })
    try {
      await page.evaluate(() => window.fixture.setQueue(3))
      for (const state of ['requesting-model', 'exec', 'waiting', 'idle', 'interrupted', 'loading']) {
        await page.evaluate(state => window.fixture.setState(state), state)
        await page.waitForFunction(state => {
          if (state === 'loading') return !!document.querySelector('[aria-label="Loading"]')
          if (state === 'idle') return !document.querySelector('[data-processing-runtime-state], [aria-label="Loading"]')
          return document.querySelector('[data-processing-runtime-state]')?.dataset.processingRuntimeState === (state === 'exec' ? 'running-tool' : state)
        }, {}, state)
        await page.waitForFunction(() => document.querySelector('[data-processing-queue-status]')?.textContent.includes('3 queued'))
        assert.equal(await page.$eval('[data-processing-queue-status] span', el => el.textContent), '3 queued')
        const alignment = await page.evaluate(() => {
          const queue = document.querySelector('[data-processing-queue-status]').getBoundingClientRect()
          const group = document.querySelector('[data-processing-queue-footer]').getBoundingClientRect()
          return { left: queue.left, expected: group.left }
        })
        assert.ok(Math.abs(alignment.left - alignment.expected) < 1, `queue stays in left-aligned flow: ${JSON.stringify(alignment)}`)
        assert.doesNotMatch(await page.$eval('[role="status"]', el => el.textContent), /will be inserted|pending/)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        assert.ok(await page.$$eval('[role="status"] button', buttons => buttons.every(button => {
          const box = button.getBoundingClientRect()
          return box.width > 0 && box.left >= 16 && box.right <= innerWidth - 16
        })))
        if (state === 'interrupted') {
          await page.click('.fw-processing-main > button')
        }
        await page.click('[data-processing-queue-status] button')
      }
      assert.deepEqual(await page.evaluate(() => [window.fixture.stops, window.fixture.continues, window.fixture.runs]), [0, 1, 6])
    } finally { await page.close() }
  }
})

test('waiting sleeps in warning color without a caption timer and respects reduced motion', async () => {
  const page=await open({width:390})
  try {
    await page.evaluate(()=>window.fixture.setState('waiting'))
    await page.waitForSelector('[data-fox-loader="sleeping"]')
    assert.equal(await page.$('[data-processing-status-dot]'),null)
    assert.equal(await page.$('[data-fox-loader="spinner"]'),null)
    assert.equal(await page.evaluate(()=>window.thinkingTimers.size),0)
    const normal=await page.$eval('[data-fox-loader="sleeping"]',el=>({
      color:getComputedStyle(el).color,caption:getComputedStyle(el.nextElementSibling).color,
      body:getComputedStyle(el.querySelector('.fw-fox-body')).animationName,
      sleep:getComputedStyle(el,'::after').animationName,
      slot:el.closest('[data-processing-status-slot]').getBoundingClientRect().height,
    }))
    assert.equal(normal.color,normal.caption)
    assert.equal(normal.body,'fw-fox-breathe')
    assert.equal(normal.sleep,'fw-fox-snooze')
    assert.equal(normal.slot,56)
    const dir=process.env.FOXWARM_E2E_SCREENSHOT_DIR
    if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:`${dir}/sleeping-waiting-mobile.png`,clip:{x:0,y:0,width:390,height:120}})}
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}])
    assert.deepEqual(await page.$eval('[data-fox-loader="sleeping"]',el=>[
      getComputedStyle(el.querySelector('.fw-fox-body')).animationName,getComputedStyle(el,'::after').animationName,
    ]),['none','none'])
    await page.evaluate(()=>window.fixture.setState('interrupted'))
    await page.waitForSelector('[data-processing-status-dot="static"]')
    assert.equal(await page.$('[data-fox-loader="sleeping"]'),null)
  }finally{await page.close()}
})
