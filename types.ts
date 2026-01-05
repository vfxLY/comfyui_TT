export enum TabType {
  FLUX = 'flux',
  EDIT = 'edit',
  SDXL = 'sdxl',
  CANVAS = 'canvas',
}

export interface GenerationStatus {
  isGenerating: boolean;
  progress: number;
  statusText: string;
  error?: string;
  imageUrl?: string;
  consoleLogs?: string;
}

export interface ComfyNode {
  inputs: Record<string, any>;
  class_type: string;
  _meta?: {
    title: string;
  };
}

export type ComfyWorkflow = Record<string, ComfyNode>;

export interface HistoryResponse {
  [promptId: string]: {
    status: {
      status_str: 'success' | 'error' | 'running';
      completed: boolean;
      messages?: any[];
      error?: string;
    };
    outputs: Record<string, {
      images: {
        filename: string;
        subfolder: string;
        type: string;
      }[];
    }>;
  };
}