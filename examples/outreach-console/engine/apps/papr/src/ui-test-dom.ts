// Minimal DOM test double. It does not claim browser focus-trap or Papr iframe coverage.
export interface UiEvent {
  currentTarget: FakeElement;
  preventDefault: () => void;
}
export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: UiEvent) => unknown>>();
  readonly classList = { add: (_name: string) => {}, remove: (_name: string) => {} };
  textContent = '';
  className = '';
  value = '';
  disabled = false;
  open = false;
  isConnected = true;
  parent: FakeElement | undefined;
  constructor(readonly tagName: string, readonly owner: FakeDocument) {}
  set innerHTML(_value: string) { throw new Error('Unsafe HTML insertion'); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, callback: (event: UiEvent) => unknown): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  async emit(name: string): Promise<void> {
    await Promise.all((this.listeners.get(name) ?? []).map((listener) => listener({ currentTarget: this, preventDefault() {} })));
  }
  append(...children: FakeElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  detach(): void { this.isConnected = false; for (const child of this.children) child.detach(); }
  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.detach();
    this.children.splice(0); this.append(...children);
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.detach();
  }
  focus(): void { this.owner.activeElement = this; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; void this.emit('close'); }
  find(tag: string): FakeElement | undefined {
    return this.tagName === tag ? this : this.children.map((child) => child.find(tag)).find(Boolean);
  }
  findText(text: string): FakeElement | undefined {
    return this.textContent === text ? this : this.children.map((child) => child.findText(text)).find(Boolean);
  }
}
export class FakeDocument {
  readonly body = new FakeElement('body', this);
  readonly documentElement = { dataset: { appId: '' } };
  readonly ids = new Map<string, FakeElement>();
  activeElement: FakeElement | undefined;
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
  getElementById(id: string): FakeElement {
    let element = this.ids.get(id);
    if (!element) { element = this.createElement('div'); this.ids.set(id, element); }
    return element;
  }
}
