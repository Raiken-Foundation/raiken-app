# Raiken Playground

A simple React + Vite test application for developing and testing Raiken features.

## 🎯 Purpose

This playground app serves as a realistic test project for Raiken development. It includes:

- **Login Form** - Form validation and authentication flow
- **Counter** - Interactive component with state management
- **Todo List** - CRUD operations with filtering and statistics
- **Utility Functions** - Various helpers for testing code analysis

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

The app runs on `http://localhost:3000`

## 🧪 Testing Features

### Project Detection
This project should be detected as:
- **Type**: `vite` (React + Vite)
- **Package Manager**: Based on lock file present
- **Test Directory**: `tests/`

### Components for E2E Testing

All components include `data-testid` attributes for easy testing:

**Login Flow:**
- `login-form` - Form container
- `username-input` - Username field
- `email-input` - Email field
- `login-submit` - Submit button

**Counter:**
- `counter-value` - Display value
- `counter-increment` - Increment button
- `counter-decrement` - Decrement button
- `counter-reset` - Reset button
- `counter-step-input` - Step size input

**Todo List:**
- `todo-input` - Input field
- `todo-add` - Add button
- `todo-list` - Todo items container
- `todo-item-{id}` - Individual todo
- `filter-all/active/completed` - Filter buttons
- `clear-completed` - Clear completed button

### Code Graph Testing

The project structure is designed to test:
- **Entry point detection** (`main.tsx`)
- **Component dependencies** (App → Counter/TodoList/LoginForm)
- **Utility function imports** (utils.ts used by multiple components)
- **Type imports** (types.ts)
- **External dependencies** (React, ReactDOM)

## 📁 Project Structure

```
playground/
├── src/
│   ├── main.tsx           # Entry point
│   ├── App.tsx            # Main app component
│   ├── types.ts           # TypeScript interfaces
│   ├── utils.ts           # Utility functions
│   ├── styles.css         # Global styles
│   └── components/
│       ├── Counter.tsx    # Counter component
│       ├── TodoList.tsx   # Todo list component
│       └── LoginForm.tsx  # Login form component
├── index.html             # HTML template
├── vite.config.ts         # Vite configuration
├── tsconfig.json          # TypeScript config
└── package.json           # Dependencies
```

## 🔍 What Raiken Can Test

### User Flows
1. **Login → Dashboard** - Authentication flow
2. **Increment Counter** - State updates
3. **Add/Complete/Delete Todos** - CRUD operations
4. **Filter Todos** - UI state management
5. **Form Validation** - Error handling

### Edge Cases
- Empty states (no todos)
- Form validation errors
- Counter with custom steps
- Completed todo cleanup

## 🎨 Features by Component

### LoginForm
- Username validation (3-20 chars)
- Email validation (optional)
- Error message display
- Form submission

### Counter
- Increment/decrement by step
- Custom step size
- Reset functionality
- Uses utility function (`sum`)

### TodoList
- Add todos
- Mark as complete/incomplete
- Delete todos
- Filter (all/active/completed)
- Clear completed
- Statistics display
- Empty state messages

## 💡 Usage in Raiken Development

This playground is perfect for testing:

1. **Project Detection** - Verify framework/dependency detection
2. **Code Analysis** - Parse components and dependencies
3. **Test Generation** - Generate E2E tests for user flows
4. **Entry Point Detection** - Find and analyze entry points
5. **Code Graph Building** - Map component relationships

