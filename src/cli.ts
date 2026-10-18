import { connect } from './client.js';

// CLI: `cli.ts tools` | `cli.ts call <tool> '<json args>'`. Actor from CARELOOP_ACTOR (synthetic member id).
async function main(): Promise<void> {
    const url = process.env.MCP_URL ?? 'http://127.0.0.1:3333/mcp';
    const [command, tool, json] = process.argv.slice(2);
    const { client, transport, wire } = await connect(url, { actor: process.env.CARELOOP_ACTOR });
    const report: Record<string, unknown> = {
        pid: process.pid,
        actor: process.env.CARELOOP_ACTOR ?? null,
        negotiatedProtocolVersion: client.getNegotiatedProtocolVersion(),
        sessionId: transport.sessionId,
        server: client.getServerVersion()
    };

    if (command === 'tools') {
        report.tools = (await client.listTools()).tools.map(t => t.name);
    } else if (command === 'call' && tool) {
        const result = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} });
        report.isError = result.isError ?? false;
        report.result = result.structuredContent ?? result.content;
        if (result.isError) process.exitCode = 1;
    } else {
        throw new Error("usage: cli.ts tools | cli.ts call <tool> '<json args>'");
    }

    await transport.terminateSession();
    await client.close();
    report.wire = wire;
    console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
