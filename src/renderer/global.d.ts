import type { ForgeApi } from '../shared/contracts';

declare global {
  interface Window {
    forge: ForgeApi;
  }
}
export {};
