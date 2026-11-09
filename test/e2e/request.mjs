// The request a real client would send, including a compress call the model already made
// and the client already executed. Printed as JSON on stdout.
const filler = "x".repeat(6000);

const body = {
  model: "fake-1",
  max_tokens: 32,
  messages: [
    { role: "system", content: "You are a careful agent." },
    { role: "user", content: "请读一下这个文件并总结。" },
    {
      role: "assistant",
      content: "好的,我先读。",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: filler },
    { role: "assistant", content: "总结:内容是一段填充文本。" },
    { role: "user", content: "把更早的细节压掉吧。" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_2",
          type: "function",
          function: {
            name: "compress",
            arguments: JSON.stringify({ content: "m00002–m00005 早期需求\n用户要求读文件并总结,已完成。" }),
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_2", content: "解析到 1 段;折叠会在下一次请求时按历史里真实的 ref 结算(本工具不写历史)。" },
    { role: "user", content: "继续" },
  ],
};

if (process.argv.includes("--stream")) body.stream = true;
// The cap fixture: one tool result big enough to blow a request on its own, in the turn being
// sent (so no fold can help it), with a sentinel in the middle that only the stored original has.
if (process.argv.includes("--big")) {
  body.messages = [
    { role: "system", content: "You are a careful agent." },
    { role: "user", content: "读一下那个超大文件。" },
    {
      role: "assistant",
      content: "好。",
      tool_calls: [{ id: "call_big", type: "function", function: { name: "read_file", arguments: '{"path":"huge.log"}' } }],
    },
    { role: "tool", tool_call_id: "call_big", content: `${"y".repeat(100000)}MIDDLE-SENTINEL${"y".repeat(100000)}` },
    { role: "user", content: "继续" },
  ];
}
// The tool gate decides on what the client DECLARES: a body that names tools but none of
// ours is a client that can never call compress, and one that names ours can.
if (process.argv.includes("--foreign-tools")) body.tools = [{ type: "function", function: { name: "read_file" } }];
if (process.argv.includes("--own-tools")) body.tools = [{ type: "function", function: { name: "magpie-acp-context_compress" } }];
// The host this plugin was written for: omp declares no MCP tool and reaches them through eval.
if (process.argv.includes("--omp-tools")) {
  body.tools = ["_read", "_bash", "_edit", "_eval", "_glob", "_grep", "_task", "_wait", "_todo", "web_search", "_write"]
    .map((name) => ({ type: "function", function: { name } }));
}
console.log(JSON.stringify(body));
