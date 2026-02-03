import type { Browser, Frame, Locator, Page } from 'playwright';

export interface AccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  level?: number;
  valuemin?: number;
  valuemax?: number;
  valuetext?: string;
  children?: AccessibilityNode[];
}

export interface CaptureOptions {
  storageStatePath?: string;
  timeout?: number;
}

export interface DOMContext {
  url: string;
  title: string;
  accessibilityTree: AccessibilityNode | null;
  timestamp: number;
  _prerequisites?: string[];
  interactiveElements: InteractiveElement[];
  formFields: FormField[];
}

export interface InteractiveElement {
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  type?: string;
  ariaLabel?: string;
  suggestedSelectors: string[];
}

export interface FormField {
  name: string;
  type: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  id?: string;
  suggestedSelector: string;
}

export async function captureDOMContext(
  url: string,
  options?: CaptureOptions
): Promise<DOMContext> {
  const { storageStatePath, timeout = 30000 } = options || {};
  let browser: Browser | null = null;

  try {
    console.log(`🌐 Launching browser to capture DOM from: ${url}`);

    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ...(storageStatePath ? { storageState: storageStatePath } : {}),
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    await page.waitForLoadState('networkidle', { timeout: Math.min(5000, timeout) }).catch(() => undefined);

    const title = await page.title();
    console.log(`📄 Page title: ${title}`);

    console.log('🔍 Extracting interactive elements...');
    const interactiveElements = await collectInteractiveElements(page);
    const formFields = await collectFormFields(page);
    
    console.log(`✓ Found ${interactiveElements.length} interactive elements`);
    console.log(`✓ Found ${formFields.length} form fields`);

    const accessibilityTree = buildSimpleTree(title, interactiveElements, formFields);

    await browser.close();
    browser = null;

    return {
      url,
      title,
      accessibilityTree: accessibilityTree as AccessibilityNode | null,
      interactiveElements,
      formFields,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('❌ DOM capture failed:', error);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

type LocatorScope = Page | Frame;

function getAllFrames(page: Page): Frame[] {
  const frames = page.frames();
  const main = page.mainFrame();
  const ordered: Frame[] = [main, ...frames.filter(frame => frame !== main)];
  const unique = new Set<Frame>();
  const deduped: Frame[] = [];
  for (const frame of ordered) {
    if (!unique.has(frame)) {
      unique.add(frame);
      deduped.push(frame);
    }
  }
  return deduped;
}

function dedupeInteractiveElements(elements: InteractiveElement[]): InteractiveElement[] {
  const seen = new Set<string>();
  const result: InteractiveElement[] = [];
  for (const el of elements) {
    const key = `${el.role || ''}|${el.name || ''}|${el.testId || ''}|${el.tagName}|${el.type || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(el);
  }
  return result;
}

function dedupeFormFields(fields: FormField[]): FormField[] {
  const seen = new Set<string>();
  const result: FormField[] = [];
  for (const field of fields) {
    const key = `${field.name}|${field.type}|${field.id || ''}|${field.suggestedSelector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(field);
  }
  return result;
}

async function collectInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  const frames = getAllFrames(page);
  const collected: InteractiveElement[] = [];
  for (const frame of frames) {
    try {
      const elements = await extractInteractiveElements(frame);
      collected.push(...elements);
    } catch {
      continue;
    }
    if (collected.length >= 60) break;
  }
  return dedupeInteractiveElements(collected).slice(0, 60);
}

async function collectFormFields(page: Page): Promise<FormField[]> {
  const frames = getAllFrames(page);
  const collected: FormField[] = [];
  for (const frame of frames) {
    try {
      const fields = await extractFormFields(frame);
      collected.push(...fields);
    } catch {
      continue;
    }
    if (collected.length >= 60) break;
  }
  return dedupeFormFields(collected).slice(0, 60);
}

async function extractInteractiveElements(page: LocatorScope): Promise<InteractiveElement[]> {
  const elements: InteractiveElement[] = [];
  
  const buttons = await page.locator('button, [role="button"], input[type="submit"], input[type="button"]').all();
  for (const btn of buttons.slice(0, 30)) {
    try {
      if (!(await isUsableElement(btn))) continue;
      const text = await btn.textContent() || await btn.getAttribute('aria-label') || '';
      const testId = await btn.getAttribute('data-testid');
      elements.push({
        tagName: 'button',
        role: 'button',
        text: text.trim(),
        name: text.trim(),
        testId: testId || undefined,
        suggestedSelectors: buildSelectors('button', text.trim(), testId),
      });
    } catch {
      // Element inaccessible
    }
  }
  
  const links = await page.locator('a[href]').all();
  for (const link of links.slice(0, 30)) {
    try {
      if (!(await isUsableElement(link))) continue;
      const text = await link.textContent() || '';
      const href = await link.getAttribute('href') || '';
      elements.push({
        tagName: 'a',
        role: 'link',
        text: text.trim(),
        name: text.trim() || href,
        suggestedSelectors: buildSelectors('link', text.trim()),
      });
    } catch {
      // Element inaccessible
    }
  }
  
  const inputs = await page.locator('input:not([type="hidden"]), textarea, select').all();
  for (const input of inputs.slice(0, 30)) {
    try {
      if (!(await isUsableElement(input))) continue;
      const type = await input.getAttribute('type') || 'text';
      const name = await input.getAttribute('name') || '';
      const placeholder = await input.getAttribute('placeholder') || '';
      const label = await input.getAttribute('aria-label') || '';
      const testId = await input.getAttribute('data-testid');
      const tagName = await input.evaluate(el => el.tagName.toLowerCase());
      const role = type === 'checkbox'
        ? 'checkbox'
        : type === 'radio'
          ? 'radio'
          : type === 'range'
            ? 'slider'
            : tagName === 'select'
              ? 'combobox'
              : 'textbox';
      elements.push({
        tagName,
        role,
        type,
        name: label || placeholder || name,
        text: placeholder,
        testId: testId || undefined,
        suggestedSelectors: buildSelectors(role, label || placeholder || name, testId),
      });
    } catch {
      // Element inaccessible
    }
  }

  const contentEditables = await page.locator('[contenteditable="true"]').all();
  for (const editable of contentEditables.slice(0, 10)) {
    try {
      if (!(await isUsableElement(editable))) continue;
      const text = await editable.textContent() || '';
      const label = await editable.getAttribute('aria-label') || '';
      const testId = await editable.getAttribute('data-testid');
      elements.push({
        tagName: 'div',
        role: 'textbox',
        text: text.trim(),
        name: label || text.trim(),
        testId: testId || undefined,
        suggestedSelectors: buildSelectors('textbox', label || text.trim(), testId),
      });
    } catch {
      // Element inaccessible
    }
  }

  const roleElements = await page
    .locator('[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"]')
    .all();
  for (const el of roleElements.slice(0, 20)) {
    try {
      if (!(await isUsableElement(el))) continue;
      const role = await el.getAttribute('role') || '';
      const text = await el.textContent() || await el.getAttribute('aria-label') || '';
      const testId = await el.getAttribute('data-testid');
      elements.push({
        tagName: 'div',
        role: role || undefined,
        text: text.trim(),
        name: text.trim(),
        testId: testId || undefined,
        suggestedSelectors: buildSelectors(role || 'button', text.trim(), testId),
      });
    } catch {
      // Element inaccessible
    }
  }
  
  return elements;
}

async function extractFormFields(page: LocatorScope): Promise<FormField[]> {
  const fields: FormField[] = [];
  
  const inputs = await page.locator('input:not([type="hidden"]), textarea, select').all();
  for (const input of inputs.slice(0, 30)) {
    try {
      if (!(await isUsableElement(input))) continue;
      const tagName = await input.evaluate(el => el.tagName.toLowerCase());
      const type = await input.getAttribute('type') || (tagName === 'textarea' ? 'textarea' : 'text');
      const name = await input.getAttribute('name') || '';
      const id = await input.getAttribute('id') || '';
      const placeholder = await input.getAttribute('placeholder') || '';
      const label = await input.getAttribute('aria-label') || '';
      const required = await input.getAttribute('required') !== null;
      
      fields.push({
        name: label || placeholder || name || id,
        type,
        label: label || undefined,
        placeholder: placeholder || undefined,
        required,
        id: id || undefined,
        suggestedSelector: id ? `#${id}` : (name ? `[name="${name}"]` : `[placeholder="${placeholder}"]`),
      });
    } catch {
      // Field inaccessible
    }
  }
  
  return fields;
}

async function isUsableElement(locator: Locator): Promise<boolean> {
  try {
    if (!(await locator.isVisible())) return false;
    const box = await locator.boundingBox();
    if (!box || box.width === 0 || box.height === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function buildSelectors(role: string, name: string, testId?: string | null): string[] {
  const selectors: string[] = [];
  if (testId) selectors.push(`getByTestId('${testId}')`);
  if (name) selectors.push(`getByRole('${role}', { name: '${name}' })`);
  if (name) selectors.push(`getByText('${name}')`);
  return selectors;
}

function buildSimpleTree(
  title: string,
  elements: InteractiveElement[],
  fields: FormField[]
): AccessibilityNode {
  const children: AccessibilityNode[] = [];
  
  for (const el of elements) {
    children.push({
      role: el.role || el.tagName,
      name: el.name || el.text,
    });
  }
  
  const elementNames = new Set(elements.map(e => e.name));
  for (const field of fields) {
    if (!elementNames.has(field.name)) {
      children.push({
        role: field.type || 'textbox',
        name: field.name,
        value: field.placeholder,
      });
    }
  }
  
  return {
    role: 'WebArea',
    name: title,
    children,
  };
}

function formatAccessibilityTree(node: AccessibilityNode | null, indent = 0): string {
  if (!node) return '(empty tree)';
  
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);
  
  let desc = `${prefix}• ${node.role}`;
  if (node.name) desc += `: "${node.name}"`;
  if (node.value) desc += ` [value: "${node.value}"]`;
  if (node.checked !== undefined) desc += ` [checked: ${node.checked}]`;
  if (node.selected) desc += ` [selected]`;
  if (node.disabled) desc += ` [disabled]`;
  if (node.expanded !== undefined) desc += ` [expanded: ${node.expanded}]`;
  
  lines.push(desc);
  
  if (node.children && indent < 4) {
    for (const child of node.children) {
      lines.push(formatAccessibilityTree(child, indent + 1));
    }
  } else if (node.children && node.children.length > 0) {
    lines.push(`${prefix}  ... (${node.children.length} more children)`);
  }
  
  return lines.join('\n');
}

export function formatDOMContext(dom: DOMContext): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `[LIVE DOM CONTEXT - ${dom.url}]`,
    '═══════════════════════════════════════════════════════════════',
    `Page Title: ${dom.title}`,
    `Captured: ${new Date(dom.timestamp).toISOString()}`,
    '',
  ];

  if (dom._prerequisites && dom._prerequisites.length > 0) {
    lines.push('[PREREQUISITES]');
    lines.push('───────────────');
    lines.push('The following steps may be needed before testing:');
    for (let i = 0; i < dom._prerequisites.length; i++) {
      lines.push(`${i + 1}. ${dom._prerequisites[i]}`);
    }
    lines.push('');
  }

  lines.push('ACCESSIBILITY TREE:');
  lines.push('───────────────────');
  lines.push(formatAccessibilityTree(dom.accessibilityTree));
  lines.push('');

  if (dom.interactiveElements && dom.interactiveElements.length > 0) {
    lines.push('INTERACTIVE ELEMENTS:');
    lines.push('─────────────────────');
    for (const el of dom.interactiveElements.slice(0, 30)) {
      lines.push(`• ${el.role}: "${el.name}"`);
      lines.push(`  Selector: ${el.suggestedSelectors[0]}`);
    }
    if (dom.interactiveElements.length > 30) {
      lines.push(`  ... and ${dom.interactiveElements.length - 30} more`);
    }
    lines.push('');
  }

  lines.push('SELECTOR PRIORITY:');
  lines.push('──────────────────');
  lines.push('1. getByRole() - Most reliable, matches accessibility tree');
  lines.push('2. getByLabel() - Great for form inputs');
  lines.push('3. getByText() - For buttons and links');
  lines.push('');
  lines.push('Use ONLY selectors from the tree above. Do NOT fabricate selectors.');
  lines.push('');

  return lines.join('\n');
}
