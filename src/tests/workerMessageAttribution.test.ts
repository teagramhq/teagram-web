import {expect, test} from 'vitest';
import {installWorkerMessageAttribution, summarizeWorkerMessageAttribution} from '../../e2e/workerMessageAttribution';

test('records batched message kinds without changing processing order or results', () => {
  let time = 100;
  const order: string[] = [];
  const port: any = {awaiting: {7: {taskType: 'managers', taskName: 'appMessagesManager', taskMethod: 'getHistory'}}, processTaskMap: {}};
  port.processTaskMap.invoke = (task: any) => { order.push(task.payload.type); time += 30; return 1; };
  port.processTaskMap.result = () => { order.push('result'); time += 40; return 2; };
  const result: unknown[] = [];
  port.onMessage = (event: any) => { result.push(port.processTaskMap[event.data.type](event.data)); };
  port.processTaskMap.batch = () => { throw new Error('the recorder dispatches batch children itself'); };
  const recording = installWorkerMessageAttribution(port, () => time);
  const batch = {type: 'batch', payload: [
    {type: 'invoke', payload: {type: 'update', payload: {_: 'updateNewMessage'}}},
    {type: 'result', payload: {taskId: 7}}
  ]};
  port.processTaskMap.batch(batch, null, {data: batch});
  expect(result).toEqual([1, 2]);
  expect(order).toEqual(['update', 'result']);
  expect(summarizeWorkerMessageAttribution([{startTime: 100, duration: 80}], recording.spans)).toEqual([{
    startTimeMs: 100,
    durationMs: 80,
    messageCount: 2,
    batchSizes: [],
    unaccountedMs: 10,
    messages: [
      {type: 'invoke:update:updateNewMessage', durationMs: 30, percent: 37.5},
      {type: 'result:managers:appMessagesManager:getHistory', durationMs: 40, percent: 50}
    ]
  }]);
});


test('restores handlers and preserves thrown errors', () => {
  const error = new Error('failure');
  const handler = () => { throw error; };
  const port: any = {awaiting: {}, processTaskMap: {invoke: handler}};
  const recording = installWorkerMessageAttribution(port, () => 100);
  expect(() => port.processTaskMap.invoke({type: 'invoke', payload: {type: 'event', payload: {name: 'history_update'}}})).toThrow(error);
  expect(recording.spans[0].type).toBe('invoke:event:history_update');
  recording.restore();
  expect(port.processTaskMap.invoke).toBe(handler);
});


test('the page-injected recorder is self-contained', () => {
  const injected = new Function(`return ${installWorkerMessageAttribution.toString()}`)() as typeof installWorkerMessageAttribution;
  const port: any = {awaiting: {}, processTaskMap: {result: () => 42}};
  const recording = injected(port, () => 10);
  expect(port.processTaskMap.result({type: 'result', payload: {taskId: 1, result: {_: 'messages.messages'}}})).toBe(42);
  expect(recording.spans[0].type).toBe('result:messages.messages');
});

test('reports unaccounted task time alongside clipped message work', () => {
  expect(summarizeWorkerMessageAttribution([
    {startTime: 100, duration: 80},
    {startTime: 200, duration: 40}
  ], [
    {type: 'invoke:event:dialogs_multiupdate', startTime: 90, duration: 40},
    {type: 'result:manager:dialogsStorage:getDialogIndex', startTime: 170, duration: 20}
  ], 90)).toEqual([{
    startTimeMs: 10,
    durationMs: 80,
    messageCount: 2,
    batchSizes: [],
    unaccountedMs: 40,
    messages: [
      {type: 'invoke:event:dialogs_multiupdate', durationMs: 30, percent: 37.5},
      {type: 'result:manager:dialogsStorage:getDialogIndex', durationMs: 10, percent: 12.5}
    ]
  }]);
});

test('coalesces consecutive peer messages without losing measured time or processing order', () => {
  let now = 10;
  const order: number[] = [];
  const port: any = {awaiting: {}, processTaskMap: {}};
  port.processTaskMap.invoke = (task: any) => { order.push(task.id); now += 2; };
  port.processTaskMap.batch = () => {};
  port.onMessage = (event: any) => port.processTaskMap.invoke(event.data);
  const recording = installWorkerMessageAttribution(port, () => now);
  const invokeWrapper = port.processTaskMap.invoke;
  const batch = {type: 'batch', payload: [1, 2, 3].map((id) => ({id, type: 'invoke', payload: {type: 'mirror', payload: {name: 'peers'}}}))};
  port.processTaskMap.batch(batch, null, {data: batch});
  expect(order).toEqual([1, 2, 3]);
  expect(port.processTaskMap.invoke).toBe(invokeWrapper);
  expect(recording.spans).toHaveLength(1);
  expect(summarizeWorkerMessageAttribution([{startTime: 10, duration: 60}], recording.spans, 0, recording.batches)[0]).toMatchObject({
    messageCount: 3,
    messages: [{type: 'invoke:mirror:peers', durationMs: 6, percent: 10}]
  });
});
