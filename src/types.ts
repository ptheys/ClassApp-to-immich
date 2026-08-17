export interface SessionData {
  capturedAt: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
}

export interface StudentProfile {
  id: string;
  name: string;
}

export interface ClassAppAttachment {
  id: string;
  url: string;
  filename?: string;
}

export interface ClassAppMessageSummary {
  id: string;
  createdAt: string;
  imagesCount: number;
}

export interface ImportedAttachment {
  messageId: string;
  attachmentId: string;
  immichAssetId: string;
  importedAt: string;
}

export interface SyncState {
  lastSyncAt: string | null;
  importedAttachments: ImportedAttachment[];
}
