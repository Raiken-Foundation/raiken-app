import { useState } from 'react';
import type { Todo, TodoFilter } from '../types';
import { generateId, filterTodos, getTodoStats } from '../utils';

function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [filter, setFilter] = useState<TodoFilter>('all');

  const addTodo = () => {
    if (inputValue.trim()) {
      const newTodo: Todo = {
        id: generateId(),
        text: inputValue.trim(),
        completed: false,
        createdAt: new Date(),
      };
      setTodos([...todos, newTodo]);
      setInputValue('');
    }
  };

  const toggleTodo = (id: string) => {
    setTodos(
      todos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  };

  const deleteTodo = (id: string) => {
    setTodos(todos.filter((todo) => todo.id !== id));
  };

  const clearCompleted = () => {
    setTodos(todos.filter((todo) => !todo.completed));
  };

  const filteredTodos = filterTodos(todos, filter);
  const stats = getTodoStats(todos);

  return (
    <div className="todo-list">
      <div className="todo-input">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && addTodo()}
          placeholder="What needs to be done?"
          data-testid="todo-input"
        />
        <button onClick={addTodo} className="btn btn-primary" data-testid="todo-add">
          Add
        </button>
      </div>

      <div className="todo-filters">
        <button
          onClick={() => setFilter('all')}
          className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
          data-testid="filter-all"
        >
          All ({stats.total})
        </button>
        <button
          onClick={() => setFilter('active')}
          className={`filter-btn ${filter === 'active' ? 'active' : ''}`}
          data-testid="filter-active"
        >
          Active ({stats.active})
        </button>
        <button
          onClick={() => setFilter('completed')}
          className={`filter-btn ${filter === 'completed' ? 'active' : ''}`}
          data-testid="filter-completed"
        >
          Completed ({stats.completed})
        </button>
      </div>

      <ul className="todo-items" data-testid="todo-list">
        {filteredTodos.map((todo) => (
          <li
            key={todo.id}
            className={`todo-item ${todo.completed ? 'completed' : ''}`}
            data-testid={`todo-item-${todo.id}`}
          >
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo(todo.id)}
              data-testid={`todo-checkbox-${todo.id}`}
            />
            <span className="todo-text">{todo.text}</span>
            <button
              onClick={() => deleteTodo(todo.id)}
              className="btn-delete"
              data-testid={`todo-delete-${todo.id}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {filteredTodos.length === 0 && (
        <p className="empty-state" data-testid="empty-state">
          {filter === 'all'
            ? 'No todos yet. Add one above!'
            : `No ${filter} todos.`}
        </p>
      )}

      {stats.completed > 0 && (
        <button
          onClick={clearCompleted}
          className="btn btn-secondary clear-completed"
          data-testid="clear-completed"
        >
          Clear Completed
        </button>
      )}

      <div className="todo-stats" data-testid="todo-stats">
        {stats.percentage}% complete
      </div>
    </div>
  );
}

export default TodoList;

