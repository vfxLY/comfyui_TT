
declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }

  interface Window {
    aistudio?: AIStudio;
    process: {
      env: {
        API_KEY?: string;
        [key: string]: string | undefined;
      };
    };
  }

  // Redundant var process declaration removed to avoid conflict with existing environment declarations.

  namespace NodeJS {
    interface ProcessEnv {
      API_KEY: string;
      [key: string]: string | undefined;
    }
  }
}

export {};
