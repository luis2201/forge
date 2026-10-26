export interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
  version: string;
  externalChanged: boolean;
  deleted: boolean;
}

export interface SelectedEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
}
