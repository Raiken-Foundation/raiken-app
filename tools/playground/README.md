# Raiken Playground

A simple React + Vite test application for developing and testing Raiken features.

## 🎯 Purpose

This playground app serves as a realistic test project for Raiken development. It includes:

- **Login Form** - Form validation and authentication flow
- **Counter** - Interactive component with state management
- **Todo List** - CRUD operations with filtering and statistics
- **Utility Functions** - Various helpers for testing code analysis

## 🚀 Getting Started

### Installation

```bash
# Navigate to the playground directory
cd tools/playground

# Install dependencies
npm install
```

### Running the App

```bash
# Start development server
npm run dev
```

The app will be available at **http://localhost:3000**

### Building for Production

```bash
# Create production build
npm run build

# Preview production build
npm run preview
```

The build output will be in the `dist/` directory.

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

## 📋 Complete Test ID Reference

All interactive elements have `data-testid` attributes for E2E testing:

### LoginForm Component
| Test ID | Element | Purpose |
|---------|---------|---------|
| `login-form` | Form container | Target the entire login form |
| `username-input` | Username input field | Enter username (required) |
| `email-input` | Email input field | Enter email (optional) |
| `username-error` | Error message | Validation error for username |
| `email-error` | Error message | Validation error for email |
| `login-submit` | Submit button | Submit login form |

### Counter Component
| Test ID | Element | Purpose |
|---------|---------|---------|
| `counter-value` | Display | Current counter value |
| `counter-increment` | Button | Increment counter by step |
| `counter-decrement` | Button | Decrement counter by step |
| `counter-reset` | Button | Reset counter to 0 |
| `counter-step-input` | Input | Set custom step size |

### TodoList Component
| Test ID | Element | Purpose |
|---------|---------|---------|
| `todo-input` | Input field | Enter new todo text |
| `todo-add` | Button | Add new todo |
| `todo-list` | Container | List of all todos |
| `todo-item-{id}` | List item | Individual todo (dynamic ID) |
| `todo-checkbox-{id}` | Checkbox | Toggle todo completion (dynamic ID) |
| `todo-delete-{id}` | Button | Delete specific todo (dynamic ID) |
| `filter-all` | Button | Show all todos |
| `filter-active` | Button | Show only active todos |
| `filter-completed` | Button | Show only completed todos |
| `clear-completed` | Button | Remove all completed todos |
| `empty-state` | Message | Shown when no todos match filter |
| `todo-stats` | Display | Completion percentage |

**Note:** Test IDs with `{id}` are dynamic and use the todo's unique ID (e.g., `todo-item-1234567890-abc123def`)

## 💡 Usage in Raiken Development

This playground is perfect for testing:

1. **Project Detection** - Verify framework/dependency detection
2. **Code Analysis** - Parse components and dependencies
3. **Test Generation** - Generate E2E tests for user flows
4. **Entry Point Detection** - Find and analyze entry points
5. **Code Graph Building** - Map component relationships

### Using with Raiken CLI

```bash
# Navigate to the playground
cd tools/playground

# Initialize Raiken (detects as Vite project)
raiken init

# Start Raiken (serves dashboard and API)
raiken start
# Open http://localhost:7101 to use the dashboard
```

**Expected Raiken Detection:**
- **Framework**: Vite (React + TypeScript)
- **Entry Point**: `src/main.tsx`
- **Components**: 3 (Counter, TodoList, LoginForm)
- **Utilities**: 11 functions in `utils.ts`
- **Types**: 3 interfaces in `types.ts`

### Test Generation Examples

**Login Flow:**
```typescript
// Raiken should generate tests like:
test('user can login with valid credentials', async () => {
  await page.goto('http://localhost:3000');
  await page.fill('[data-testid="username-input"]', 'testuser');
  await page.fill('[data-testid="email-input"]', 'test@example.com');
  await page.click('[data-testid="login-submit"]');
  await expect(page.locator('text=Welcome, testuser!')).toBeVisible();
});
```

**Counter Flow:**
```typescript
// Raiken should generate tests like:
test('counter increments correctly', async () => {
  // ... after login
  await page.click('[data-testid="counter-increment"]');
  await expect(page.locator('[data-testid="counter-value"]')).toHaveText('1');
});
```

**Todo Flow:**
```typescript
// Raiken should generate tests like:
test('user can add and complete todos', async () => {
  // ... after login
  await page.fill('[data-testid="todo-input"]', 'Buy milk');
  await page.click('[data-testid="todo-add"]');
  await expect(page.locator('[data-testid="todo-list"]')).toContainText('Buy milk');
});
```

