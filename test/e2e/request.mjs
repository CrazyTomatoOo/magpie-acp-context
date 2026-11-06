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
    { role: "tool", tool_call_id: "call_2", content: '{"ok":true}' },
    { role: "user", content: "继续" },
  ],
};

if (process.argv.includes("--stream")) body.stream = true;
if (process.argv.includes("--stream")) body.stream = true;
console.log(JSON.stringify(body));
