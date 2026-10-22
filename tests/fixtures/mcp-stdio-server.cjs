const readline = require('node:readline');

const startedAt = Date.now();
const tools = [
  {
    name: 'echo',
    description: 'Returns the text it receives',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  {
    name: 'environment',
    description: 'Reports the working folder, variable names and process identity',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

const environment = () => ({
  cwd: process.cwd(),
  variables: Object.keys(process.env).sort(),
  pid: process.pid,
  startedAt,
});

const call = params => {
  if (params?.name === 'echo') {
    return { content: [{ type: 'text', text: String(params.arguments?.text ?? '') }] };
  }
  if (params?.name === 'environment') {
    return { content: [{ type: 'text', text: JSON.stringify(environment()) }] };
  }
  return null;
};

const answer = request => {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: request.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'nesvo-fixture-mcp', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools };
    case 'tools/call':
      return call(request.params);
    default:
      return null;
  }
};

readline.createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.id === undefined) {
    return;
  }
  const result = answer(request);
  if (result === null) {
    send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  send({ id: request.id, result });
});

process.stdin.on('end', () => process.exit(0));
