import { useState } from 'react';
import { sum } from '../utils';

function Counter() {
  const [count, setCount] = useState(0);
  const [step, setStep] = useState(1);

  const increment = () => setCount((c) => sum(c, step));
  const decrement = () => setCount((c) => c - step);
  const reset = () => setCount(0);

  return (
    <div className="counter">
      <div className="counter-display" data-testid="counter-value">
        {count}
      </div>

      <div className="counter-controls">
        <button
          onClick={decrement}
          className="btn btn-secondary"
          data-testid="counter-decrement"
        >
          -
        </button>
        <button
          onClick={reset}
          className="btn btn-secondary"
          data-testid="counter-reset"
        >
          Reset
        </button>
        <button
          onClick={increment}
          className="btn btn-primary"
          data-testid="counter-increment"
        >
          +
        </button>
      </div>

      <div className="counter-step">
        <label htmlFor="step">Step:</label>
        <input
          id="step"
          type="number"
          min="1"
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
          data-testid="counter-step-input"
        />
      </div>
    </div>
  );
}

export default Counter;

