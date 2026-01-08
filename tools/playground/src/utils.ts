import type { Todo } from './types';

export const sum = (a: number, b: number): number => a + b;

export const generateId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const validateUsername = (username: string): boolean => {
  return username.length >= 3 && username.length <= 20;
};

export const formatDate = (date: Date): string => {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
};

export const filterTodos = (
  todos: Todo[],
  filter: 'all' | 'active' | 'completed'
): Todo[] => {
  switch (filter) {
    case 'active':
      return todos.filter((todo) => !todo.completed);
    case 'completed':
      return todos.filter((todo) => todo.completed);
    default:
      return todos;
  }
};

export const sortTodosByDate = (todos: Todo[]): Todo[] => {
  return [...todos].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
};

export const getCompletedCount = (todos: Todo[]): number => {
  return todos.filter((todo) => todo.completed).length;
};

export const getTodoStats = (todos: Todo[]) => {
  const total = todos.length;
  const completed = getCompletedCount(todos);
  const active = total - completed;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, active, percentage };
};
