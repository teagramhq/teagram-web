import {expect, test} from 'vitest';
import {installWorkerMessageAttribution, summarizeWorkerMessageAttribution} from '../../e2e/workerMessageAttribution';

test('records batched message kinds without changing processing order or results', () => {
  let time = 100;
  const order: string[] = [];
  const port: any = {awaiting: {7: {taskType: 'managers', taskName: 'appMessagesManager', taskMethod: 'getHistory'}}, processTaskMap: {}};
  port.processTaskMap.invoke = (task: any) => { order.push(task.payload.type); time += 30; return 1; };
  port.processTaskMap.result = () => { order.push('result'); time += 40; return 2; };
  port.processTaskMap.batch = (task: any) => task.payload.map((child: any) => port.processTaskMap[child.type](child));
  const recording = installWorkerMessageAttribution(port, () => time);
  const result = port.processTaskMap.batch({type: 'batch', payload: [
    {type: 'invoke', payload: {type: 'update', payload: {_: 'updateNewMessage'}}},
    {type: 'result', payload: {taskId: 7}}
  ]});
  expect(result).toEqual([1, 2]);
  expect(order).toEqual(['update', 'result']);
  expect(summarizeWorkerMessageAttribution([{startTime: 100, duration: 80}], recording.spans)).toEqual([{
    startTimeMs: 100,
    durationMs: 80,
    messageCount: 2,
    batchSizes: [],
    recorderOverheadMs: 0,
    measuredOverheadCouldCross50Ms: false,
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
    recorderOverheadMs: 0,
    measuredOverheadCouldCross50Ms: false,
    unaccountedMs: 40,
    messages: [
      {type: 'invoke:event:dialogs_multiupdate', durationMs: 30, percent: 37.5},
      {type: 'result:manager:dialogsStorage:getDialogIndex', durationMs: 10, percent: 12.5}
    ]
  }]);
});

test('reports recorder time and batch sizes for each observed long task', () => {
  let time = 0;
  const port: any = {awaiting: {}, processTaskMap: {}};
  port.processTaskMap.invoke = () => { time += 40; };
  port.processTaskMap.batch = (task: any) => task.payload.forEach((child: any) => port.processTaskMap.invoke(child));
  const recording: any = installWorkerMessageAttribution(port, () => time++);
  const message = {type: 'invoke', payload: {type: 'event', payload: {name: 'dialogs_multiupdate'}}};
  port.processTaskMap.batch({type: 'batch', payload: [message, message]});
  const summary = summarizeWorkerMessageAttribution([{startTime: 0, duration: 100}], recording.spans, 0, recording.batches);
  expect(summary[0]).toMatchObject({messageCount: 2, batchSizes: [2], recorderOverheadMs: 4, measuredOverheadCouldCross50Ms: false});
});

test('counts clock-resolution-sized messages and flags a near-threshold task', () => {
  const summary = summarizeWorkerMessageAttribution([{startTime: 10, duration: 51}], [
    {type: 'result', startTime: 20, duration: 0, recorderStart: 20, recorderEnd: 20},
    {type: 'invoke:event:update', startTime: 30, duration: 5, recorderStart: 29, recorderEnd: 36}
  ], 0, [{startTime: 20, endTime: 20, size: 2}]);
  expect(summary[0]).toMatchObject({messageCount: 2, batchSizes: [2], recorderOverheadMs: 2, measuredOverheadCouldCross50Ms: true});
});
