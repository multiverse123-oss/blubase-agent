export type BackendType = 'pocketbase' | 'silobase' | 'custom';

export interface BackendConnection {
  id: string;
  type: BackendType;
  name: string;
  url: string;
  email?: string;
  password?: string;
  token?: string;
  createdAt: string;
}

export interface AgentAction {
  action:
    | 'connect'
    | 'list_collections'
    | 'create_collection'
    | 'list_records'
    | 'create_record'
    | 'update_record'
    | 'delete_record'
    | 'call_edge_function'
    | 'help';
  backend?: string;
  name?: string;
  url?: string;
  email?: string;
  password?: string;
  token?: string;
  collection?: string;
  id?: string;
  data?: any;
  query?: any;
  schema?: any;
  function?: string;
  message?: string;
}

export interface Adapter {
  authenticate(): Promise<void>;
  list(collection: string, query: any): Promise<any>;
  create(collection: string, data: any): Promise<any>;
  update(collection: string, id: string, data: any): Promise<any>;
  delete(collection: string, id: string): Promise<any>;
  getCollections(): Promise<any>;
  createCollection(schema: any): Promise<any>;
  callEdgeFunction(name: string, payload: any): Promise<any>;
}
