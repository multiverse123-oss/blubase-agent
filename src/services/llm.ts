import { config } from '../config';
import { AgentAction, BackendConnection } from '../types';

export async function interpretCommand(message: string, connections: BackendConnection[]): Promise<AgentAction> {
  if (!config.llm.apiKey) {
    throw new Error('AGENT_LLM_API_KEY is not configured');
  }

  const backends = connections.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    url: c.url
  }));

  const system = `You are the AI brain of BluBase Agent, an agentic backend that is powered by self-hosted backends (PocketBase, SiloBase, custom REST).
Convert the user's natural language request into a JSON action.

Available backends:
${JSON.stringify(backends, null, 2)}

Allowed JSON actions:
1. connect - connect a new backend. Example:
{
  "action": "connect",
  "backend": "pocketbase",
  "name": "my-pocketbase",
  "url": "https://pb.example.com",
  "email": "admin@example.com",
  "password": "secret",
  "token": ""
}
2. list_collections - list collections of a backend. Example: {"action":"list_collections","backend":"my-pocketbase"}
3. create_collection - create a collection. Example: {"action":"create_collection","backend":"my-pocketbase","schema":{"name":"posts","fields":[{"name":"title","type":"text"}]}}
4. list_records - list records. Example: {"action":"list_records","backend":"my-pocketbase","collection":"posts","query":{"page":1,"perPage":10,"filter":""}}
5. create_record - create a record. Example: {"action":"create_record","backend":"my-pocketbase","collection":"posts","data":{"title":"Hello"}}
6. update_record - update a record. Example: {"action":"update_record","backend":"my-pocketbase","collection":"posts","id":"RECORD_ID","data":{"title":"Updated"}}
7. delete_record - delete a record. Example: {"action":"delete_record","backend":"my-pocketbase","collection":"posts","id":"RECORD_ID"}
8. call_edge_function - call an edge function. Example: {"action":"call_edge_function","backend":"my-pocketbase","function":"sendEmail","data":{"to":"a@b.com"}}
9. help - when request is unclear. Example: {"action":"help","message":"Please specify what you want to do."}

Rules:
- Use existing backend id/name if user refers to one. If not specified and only one backend exists, use that.
- For connect, backend can be "pocketbase", "silobase", or "custom".
- Return ONLY valid JSON, no markdown.`;

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content) as AgentAction;
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content}`);
  }
}
