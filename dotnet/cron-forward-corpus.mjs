// Deterministic forward scheduling inputs. Expected results come from the actual Source parser.
const cases = [];
const add = (id, expression, zone='UTC', cursor='2024-01-01T00:00:00Z', count=12) => cases.push({id, expression, zone, cursor, count});
const grammar = [
  '*/15 * * * *','5 */7 * * * *','0 4 1,15 * 5','0 0 L * *','0 0 0 * * 1L','0 0 * * 2#3',
  '0 0 * JAN,MAR MON-FRI','0 8-18/2 * * *','5,25,45 9 * * 0,7','0 0 29 2 *','0 0 31 * *',
  '0 0 * * 1,3L','0 0 1 * 1','0 0 ? * 1','0 0 1 * ?','0 0 * * 0L','0 0 * * 7L',
  '@yearly','@monthly','@weekly','@daily','@hourly','5','*/10 *','2 * *','0 12 * *',
  '0 0 15W * *','0 0 LW * *','H * * * *','0 0 * * 5-1','0 0 * NOV-FEB *',
  '0 0 * * 1#6','0 0 * * 1#2,3#2','61 * * * * *','*/0 * * * *','0 0 0 1 1 * 2027',
  'not-a-cron','2099','0 0 * * FUNDAY','0 0 * SEPTEMBER *','0 0 * * MONL'
];
grammar.forEach((expression, i)=>add('grammar-'+i,expression));
['0 0 16 * 0-6','0 0 16 * 0-7','0 0 16 * *','0 0 1-30 * MON','0 0 1-31 * MON','0 0 16 * 1#2'].forEach((expression,i)=>add('grammar-extra-'+i,expression,'UTC','2024-04-01T00:00:00Z',12));
for (const [zone,spring,fall,early,late] of [
  ['America/New_York','2024-03-10T05:00:00Z','2024-11-03T04:00:00Z','30 2 * * *','30 1 * * *'],
  ['Europe/Berlin','2024-03-31T00:00:00Z','2024-10-27T00:00:00Z','30 2 * * *','30 2 * * *'],
  ['Australia/Lord_Howe','2024-10-05T13:00:00Z','2024-04-06T13:00:00Z','15 2 * * *','45 1 * * *'],
  ['Africa/Casablanca','2024-04-14T00:00:00Z','2024-03-10T00:00:00Z','30 2 * * *','30 2 * * *']
]) {
  add(zone+'-spring-fixed',early,zone,spring,5); add(zone+'-fall-fixed',late,zone,fall,5);
  for (const [label,cursor] of [['spring',spring],['fall',fall]]) {
    add(zone+'-'+label+'-quarter','*/15 * * * *',zone,cursor,120);
    add(zone+'-'+label+'-hour','0 * * * *',zone,cursor,36);
    add(zone+'-'+label+'-range','0 1-4 * * *',zone,cursor,12);
    add(zone+'-'+label+'-seconds','*/10 * 1-4 * * *',zone,cursor,100);
  }
}
for (const zone of ['UTC','Asia/Kathmandu','Asia/Kolkata','Pacific/Apia']) {
  add(zone+'-local','23 7 * * *',zone,'2024-06-01T00:00:00Z',5);
  add(zone+'-last','0 0 L * *',zone,'2024-01-01T00:00:00Z',12);
}
add('cursor-inside-skipped','30 2 * * *','America/New_York','2024-03-10T07:01:00Z',5);
add('cursor-inside-repeated','30 1 * * *','America/New_York','2024-11-03T06:01:00Z',5);
add('cursor-exact','*/10 * * * * *','UTC','2024-01-01T00:00:10Z',6);
add('cursor-subsecond','*/10 * * * * *','UTC','2024-01-01T00:00:09.900Z',6);
for(const [zone,spring,fall] of [
 ['America/New_York','2024-03-10T06:59:00Z','2024-11-03T05:59:00Z'],
 ['Europe/Berlin','2024-03-31T00:59:00Z','2024-10-27T00:59:00Z'],
 ['Australia/Lord_Howe','2024-10-05T15:29:00Z','2024-04-06T14:59:00Z'],
 ['Africa/Casablanca','2024-04-14T01:59:00Z','2024-03-10T01:59:00Z']
]) for(const [label,cursor] of [['spring',spring],['fall',fall]]) {
 add(zone+'-'+label+'-boundary-partial-hour','*/10 * 1-4 * * *',zone,cursor,120);
 add(zone+'-'+label+'-boundary-all-hours','*/10 * * * * *',zone,cursor,120);
}

// Holdout inputs added after the initial 115-case translation passed unchanged.
let seed = 0x5a17d3c9;
const random = count => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % count; };
const minutes = ['*', '*/7', '4,19,47', '13-41/9', '0', '59'];
const hours = ['*', '0', '1', '2', '3', '1-4', '0,6,13,21', '*/5'];
const days = ['*', '1,15', 'L', '1-30', '29', '1,1,8,15,22'];
const months = ['*', 'JAN,MAR,JUL', '2', '4-10/2'];
const weekdays = ['*', '0-6', '0-7', 'MON-FRI', '1L', '0,7', '2#3'];
const zones = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe', 'Africa/Casablanca', 'Asia/Kathmandu', 'Asia/Kolkata', 'Pacific/Apia'];
for (let index = 0; index < 192; index++) {
  const fields = [minutes[random(minutes.length)], hours[random(hours.length)], days[random(days.length)], months[random(months.length)], weekdays[random(weekdays.length)]];
  if (random(2)) fields.unshift(['0', '*/11', '3,17,39', '58'][random(4)]);
  const cursor = new Date(Date.UTC(2020 + random(13), random(12), 1 + random(28), random(24), random(60), random(60), random(1000))).toISOString();
  add('holdout-' + index, fields.join(' '), zones[random(zones.length)], cursor, 4);
}
for (const expression of ['0 0 * * 1#1.5', '0 0 31 2 *', '0 0 * * L', '0 0 * * 1#0x2', '0 0 * * 1#1e0', '0 0 1-2-3 * *', '0 0 1L * *', '0 0 L/2 * *', '0 0 * * 6-7/2', '0 0 * * 0-7/2', '0 0 * * 0,0,0,0,0,0,0,0', '0 0 * * 1#0', '0 0 * * 1#6', '0 0 * * 1#2#3', '0 0 * * 1/2#3', '0 0 * * 1-3#2', '0 0 * * 1,2#3', '0 0 * * 1#Infinity', '0 0 * * 1#NaN', '0 0 * * 1#', '0 0 * * ?*']) add('holdout-extra-' + cases.length, expression, 'UTC', '2024-01-01T00:00:00Z', 3);
add('holdout-end', '0 0 1 2 *', 'UTC', '2024-01-01T00:00:00Z', 1); cases.at(-1).end = '2024-01-01T00:01:00Z';
export default cases;
