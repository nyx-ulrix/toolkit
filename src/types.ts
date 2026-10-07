export type Values = Record<string, any>;
export type Out = { name: string; blob: Blob; note?: string };
export type Ctx = { progress: (fraction: number, message?: string) => void };

export type Opt = {
  key: string;
  label: string;
  type: 'select' | 'range' | 'number' | 'checkbox' | 'color';
  value: string | number | boolean;
  choices?: [value: string, label: string][];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** Hide the option unless this returns true. */
  show?: (o: Values) => boolean;
};

/** A tool is "files in, files out": the page builds the whole UI from this. */
export interface Tool {
  id: string;
  group: string;
  title: string;
  desc: string;
  accept: string;
  note?: string;
  opts?: Opt[];
  run(file: File, o: Values, ctx: Ctx): Promise<Out[]>;
  /** A tool with its own page (the background editor) renders itself instead of the generic file queue. */
  mount?(root: HTMLElement): void;
}
