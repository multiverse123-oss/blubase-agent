import { BackendConnection, BackendType } from '../types';
import { config } from '../config';
import { randomUUID } from 'crypto';

const connections = new Map<string, BackendConnection>();

function addConnection(input: {
  type: BackendType;
  name?: string;
  url: string;
  email?: string;
  password?: string;
  token?: string;
}): BackendConnection {
  const id = randomUUID();
  const conn: BackendConnection = {
    id,
    type: input.type,
    name: input.name || input.type,
    url: input.url.replace(/\/$/, ''),
    email: input.email,
    password: input.password,
    token: input.token,
    createdAt: new Date().toISOString()
  };
  connections.set(id, conn);
  return conn;
}

export const connectionManager = {
  add: addConnection,
  get(id: string) {
    return connections.get(id);
  },
  findByNameOrType(nameOrType: string): BackendConnection | undefined {
    for (const conn of connections.values()) {
      if (conn.id === nameOrType || conn.name === nameOrType || conn.type === nameOrType) {
        return conn;
      }
    }
    return undefined;
  },
  list(): BackendConnection[] {
    return Array.from(connections.values()).map(({ password, token, ...safe }) => safe) as BackendConnection[];
  },
  listInternal(): BackendConnection[] {
    return Array.from(connections.values());
  },
  remove(id: string) {
    connections.delete(id);
  }
};

// Preload connections from environment variables
if (config.preload.pocketbase.url) {
  addConnection({
    type: 'pocketbase',
    name: 'pocketbase',
    url: config.preload.pocketbase.url,
    email: config.preload.pocketbase.email,
    password: config.preload.pocketbase.password,
    token: config.preload.pocketbase.token
  });
}
if (config.preload.silobase.url) {
  addConnection({
    type: 'silobase',
    name: 'silobase',
    url: config.preload.silobase.url,
    email: config.preload.silobase.email,
    password: config.preload.silobase.password,
    token: config.preload.silobase.token
  });
}
if (config.preload.custom.url) {
  addConnection({
    type: 'custom',
    name: 'custom',
    url: config.preload.custom.url,
    email: config.preload.custom.email,
    password: config.preload.custom.password,
    token: config.preload.custom.token
  });
}
