export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: Date;
}

export interface User {
  username: string;
  email?: string;
}

export type TodoFilter = 'all' | 'active' | 'completed';

