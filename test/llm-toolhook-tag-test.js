const test = require('tape');
const sinon = require('sinon');
const TaskLlm = require('../lib/tasks/llm');

// Regression test for #1284: the LLM tool hook (llm:tool-call) must carry the
// tag/customerData that was set via the `tag` verb, the same way every other
// verb/action hook does via callInfo.toJSON(). Before the fix the payload was
// just {tool_call_id, ...data}, so applications never saw their tag data on a
// tool call (over webhook or websocket).

const buildFakeTask = (customerData) => {
  const requestor = { request: sinon.stub().resolves(undefined) };
  // Object.create so the real `toolHook` getter (reads this.llm?.toolHook) resolves.
  const task = Object.create(TaskLlm.prototype);
  task.cs = { requestor, callInfo: { customerData } };
  task.llm = { toolHook: { url: '/tool' } };
  return task;
};

test('sendToolHook: includes customerData (tag) in the tool-call payload', async (t) => {
  const task = buildFakeTask({ accountId: 'abc', foo: 'bar' });

  await TaskLlm.prototype.sendToolHook.call(task, 'tc-1', { name: 'lookup', args: { q: 1 } });

  t.ok(task.cs.requestor.request.calledOnce, 'requestor.request called once');
  const [type, hook, payload] = task.cs.requestor.request.firstCall.args;
  t.equal(type, 'llm:tool-call', 'hook type is llm:tool-call');
  t.equal(hook, task.llm.toolHook, 'hook target is the toolHook');
  t.deepEqual(payload.customerData, { accountId: 'abc', foo: 'bar' }, 'customerData is included');
  t.equal(payload.tool_call_id, 'tc-1', 'tool_call_id is preserved');
  t.equal(payload.name, 'lookup', 'tool data (name) is preserved');
  t.end();
});

test('sendToolHook: omits customerData when no tag was set', async (t) => {
  const task = buildFakeTask(undefined);

  await TaskLlm.prototype.sendToolHook.call(task, 'tc-2', { name: 'lookup', args: {} });

  const [, , payload] = task.cs.requestor.request.firstCall.args;
  t.notOk('customerData' in payload, 'customerData key is absent when unset');
  t.equal(payload.tool_call_id, 'tc-2', 'tool_call_id is preserved');
  t.end();
});
