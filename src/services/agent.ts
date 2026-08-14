import { BackendConnection, AgentAction, Adapter } from '../types';
import { connectionManager } from './connectionManager';
import { PocketBaseAdapter } from './pocketbaseAdapter';
import { RestBackendAdapter } from './restBackendAdapter';
import { interpretCommand } from './llm';

function getAdapter(conn: BackendConnection): Adapter {
  if (conn.type === 'pocketbase') return new PocketBaseAdapter(conn);
  return new RestBackendAdapter(conn);
}

function findBackend(backend?: string): BackendConnection {
  if (backend) {
    const conn = connectionManager.findByNameOrType(backend);
    if (conn) return conn;
  }
  const all = connectionManager.listInternal();
  if (all.length === 1) return all[0];
  throw new Error(backend ? `Backend "${backend}" not found` : 'No backend specified and multiple backends available');
}

export async function runAgent(message: string) {
  const conns = connectionManager.listInternal();
  const action = await interpretCommand(message, conns);

  switch (action.action) {
    case 'connect': {
      if (!action.url) throw new Error('Connect action requires url');
      const conn = connectionManager.add({
        type: (action.backend as any) || 'custom',
        name: action.name,
        url: action.url,
        email: action.email,
        password: action.password,
        token: action.token
      });
      const adapter = getAdapter(conn);
      await adapter.authenticate();
      return {
        success: true,
        message: `Connected ${conn.name} (${conn.type})`,
        connection: { id: conn.id, type: conn.type, name: conn.name, url: conn.url }
      };
    }
    case 'list_collections': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const collections = await adapter.getCollections();
      return { success: true, backend: conn.name, collections };
    }
    case 'create_collection': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const result = await adapter.createCollection(action.schema);
      return { success: true, backend: conn.name, result };
    }
    case 'list_records': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const records = await adapter.list(action.collection || '', action.query);
      return { success: true, backend: conn.name, collection: action.collection, records };
    }
    case 'create_record': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const record = await adapter.create(action.collection || '', action.data);
      return { success: true, backend: conn.name, collection: action.collection, record };
    }
    case 'update_record': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const record = await adapter.update(action.collection || '', action.id || '', action.data);
      return { success: true, backend: conn.name, collection: action.collection, record };
    }
    case 'delete_record': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      await adapter.delete(action.collection || '', action.id || '');
      return { success: true, backend: conn.name, collection: action.collection, deletedId: action.id };
    }
    case 'call_edge_function': {
      const conn = findBackend(action.backend);
      const adapter = getAdapter(conn);
      const result = await adapter.callEdgeFunction(action.function || '', action.data || {});
      return { success: true, backend: conn.name, function: action.function, result };
    }
    case 'help':
      return { success: false, message: action.message || 'Please clarify your request.' };
    default:
      throw new Error('Unknown action from LLM');
  }
}
