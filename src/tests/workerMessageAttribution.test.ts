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
