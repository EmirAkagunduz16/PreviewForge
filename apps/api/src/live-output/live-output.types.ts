import type { ProjectAuthPort } from "../projects/project.types.js";

export type LiveOutputAuthPort = ProjectAuthPort;

export interface LiveOutputDashboardPort {
  findDeployment(ownerId: string, deploymentId: string): Promise<unknown | null>;
}

export type LiveOutputLogPage = {
  kind: "found";
  chunks: Array<{
    sequence: number;
    stage: string;
    stream: string;
    text: string;
    createdAt: Date;
  }>;
  gap: null | { resumeSequence: number };
  nextSequence: number;
  hasMore: boolean;
};

export interface LiveOutputLogPort {
  readPage(
    ownerId: string,
    deploymentId: string,
    options: { after: number; limit: number },
  ): Promise<LiveOutputLogPage | { kind: "missing" }>;
}

export type LiveOutputConnection = {
  start(): void;
  send(frame: string): void;
  onClose(callback: () => void): () => void;
  end(): void;
};
