import fs from 'fs-extra';
import path from 'path';
import {
    ToolArgs,
    ToolContext,
    resolveAgentPath,
    shouldEnforceIsolatedMasterPathAccess,
} from './helpers';
import { checkPathAccess } from '../isolatedCheck';
import { cropImageById, cropImageForSession, resolveImageById, resolveImageForSession } from '../toolImages';
import { nodesManager } from '../nodes/manager';
import { getAgentDir } from '../config';
import { copyBetweenNodes } from '../nodeExecution';

function getTrustedCurrentSession(ctx: ToolContext) {
    if (!ctx.persistCurrentSession || !ctx.session || !ctx.sessionId) return undefined;
    return ctx.session.id === ctx.sessionId ? ctx.session : undefined;
}

function boundedError(error: unknown): string {
    return String((error as any)?.message || error).slice(0, 4096);
}

async function writeWorkerRemoteImage(options: {
    sessionId: string; agentName: string; targetNode: string; targetPath: string; overwrite: boolean;
    imageId: string; buffer: Buffer;
}): Promise<string> {
    const agentDir = getAgentDir(options.agentName);
    const handoffRoot = path.join(agentDir, '.temp', 'image-write-handoff');
    await fs.ensureDir(path.dirname(handoffRoot));
    try { await fs.mkdir(handoffRoot, { mode: 0o700 }); }
    catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    const rootStat = await fs.lstat(handoffRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Image handoff root must be a real directory.');
    const [realAgentDir, realRoot] = await Promise.all([fs.realpath(agentDir), fs.realpath(handoffRoot)]);
    if (realRoot !== realAgentDir && !realRoot.startsWith(realAgentDir + path.sep)) throw new Error('Image handoff root escapes the agent directory.');

    let operationDir: string | undefined; let result: string | undefined; let operationError: unknown;
    try {
        operationDir = await fs.mkdtemp(path.join(realRoot, 'operation-'));
        const extension = path.extname(options.targetPath).slice(0, 32);
        const tempPath = path.join(operationDir, `image${extension}`);
        await fs.writeFile(tempPath, options.buffer, { flag: 'wx', mode: 0o600 });
        await copyBetweenNodes(options.sessionId, { sourceNode: 'master', sourcePath: tempPath,
            targetNode: options.targetNode, targetPath: options.targetPath, overwrite: options.overwrite });
        result = [
            `Image \`${options.imageId}\` written to \`${options.targetPath}\` on node \`${options.targetNode}\`.`,
            `You can send it with send_file({ filePath: "${options.targetPath}", node: "${options.targetNode}" }).`,
        ].join('\n');
    } catch (error) { operationError = error; }

    let cleanupError: unknown;
    if (operationDir) {
        try { await fs.remove(operationDir); }
        catch (error) { cleanupError = error; }
    }
    if (operationError && cleanupError) throw new Error(`Image handoff failed: ${boundedError(operationError)}; cleanup failed: ${boundedError(cleanupError)}`);
    if (cleanupError) throw new Error(`Image handoff cleanup failed: ${boundedError(cleanupError)}`);
    if (operationError) throw operationError;
    if (!result) throw new Error('Image handoff completed without a result.');
    return result;
}

export async function tool_image_crop(args: ToolArgs, ctx: ToolContext) {
    const { id, x, y, width, height } = args;

    if (!ctx.sessionId) {
        throw new Error('image_crop requires an active session context.');
    }
    if (!id || typeof id !== 'string') {
        throw new Error('image_crop requires id.');
    }

    const trustedSession = getTrustedCurrentSession(ctx);
    const crop = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
    };
    const cropped = trustedSession
        ? await cropImageForSession(trustedSession, id, crop)
        : await cropImageById(ctx.sessionId, id, crop);

    return {
        output: `[Cropped image from ${id}]`,
        sourceImageId: id,
        crop: {
            x: Number(x),
            y: Number(y),
            width: Number(width),
            height: Number(height),
        },
        mimeType: cropped.imageMeta.mimeType,
        sizeBytes: cropped.imageMeta.sizeBytes,
        inlineData: cropped.inlineData,
    };
}

export async function tool_image_write_to_file(args: ToolArgs, ctx: ToolContext) {
    const { id, filePath, overwrite = false } = args;

    if (!ctx.sessionId) {
        throw new Error('image_write_to_file requires an active session context.');
    }
    if (!id || typeof id !== 'string') {
        throw new Error('image_write_to_file requires id.');
    }
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('image_write_to_file requires filePath.');
    }

    const sessionId = ctx.sessionId;
    const trustedSession = getTrustedCurrentSession(ctx);
    const currentNode = ctx.runtimeNodeId
        || ctx.session?.currentNode
        || (trustedSession ? 'master' : await nodesManager.getCurrentNode(sessionId))
        || 'master';
    const targetNode = currentNode;
    const resolved = trustedSession
        ? await resolveImageForSession(trustedSession, id)
        : await resolveImageById(sessionId, id);

    if (targetNode === 'master') {
        const agentName = ctx.session?.agent || 'main';
        const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
        if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
            checkPathAccess(fullPath, agentName);
        }
        const exists = await fs.pathExists(fullPath);
        if (exists && overwrite !== true) {
            throw new Error(`File already exists: ${filePath}. Use overwrite=true to overwrite.`);
        }
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, resolved.buffer);
    } else {
        if (ctx.sessionPlacement === 'session-worker') {
            return await writeWorkerRemoteImage({ sessionId, agentName: ctx.session?.agent || 'main', targetNode,
                targetPath: filePath, overwrite: overwrite === true, imageId: id, buffer: resolved.buffer });
        } else {
            await nodesManager.writeFileToNode(targetNode, filePath, resolved.buffer.toString('base64'), overwrite === true, sessionId);
        }
    }

    return [
        `Image \`${id}\` written to \`${filePath}\` on node \`${targetNode}\`.`,
        'You can send it with send_file({ filePath: "' + filePath + '"' + (targetNode !== 'master' ? ', node: "' + targetNode + '"' : '') + ' }).',
    ].join('\n');
}
