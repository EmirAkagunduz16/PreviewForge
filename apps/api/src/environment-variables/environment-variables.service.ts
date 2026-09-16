import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ProjectEnvironmentLimitError,
  type ProjectEnvironmentRepository,
} from "@previewforge/database";
import { type CredentialCipher, projectEnvironmentAssociatedData } from "@previewforge/security";
import type { ProjectAuthPort } from "../projects/project.types.js";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_VALUE_BYTES = 16 * 1024;

@Injectable()
export class EnvironmentVariablesService {
  private readonly publicOrigin: string;

  constructor(
    private readonly auth: ProjectAuthPort,
    private readonly repository: ProjectEnvironmentRepository,
    private readonly cipher: CredentialCipher,
    publicBaseUrl: string,
  ) {
    this.publicOrigin = new URL(publicBaseUrl).origin;
  }

  async list(session: string | undefined, projectId: string) {
    const { userId } = await this.auth.authenticate(session);
    this.validateProjectId(projectId);
    if (!(await this.repository.hasOwnedProject(userId, projectId))) throw new NotFoundException();
    return { items: await this.repository.listNames(userId, projectId) };
  }

  async put(
    session: string | undefined,
    origin: string | undefined,
    projectId: string,
    key: string,
    body: unknown,
  ) {
    const { userId } = await this.auth.authenticate(session);
    this.validateProjectId(projectId);
    this.requireSameOrigin(origin);
    this.validateKey(key);
    const value = parseValue(body);
    if (!(await this.repository.hasOwnedProject(userId, projectId))) throw new NotFoundException();
    const associatedData = projectEnvironmentAssociatedData(projectId, key);
    try {
      const saved = await this.repository.upsert(
        userId,
        projectId,
        key,
        this.cipher.encrypt(value, associatedData),
      );
      if (!saved) throw new NotFoundException();
      return saved;
    } catch (error) {
      if (error instanceof ProjectEnvironmentLimitError)
        throw new BadRequestException("Project environment variable key limit exceeded");
      throw error;
    }
  }

  async delete(
    session: string | undefined,
    origin: string | undefined,
    projectId: string,
    key: string,
  ) {
    const { userId } = await this.auth.authenticate(session);
    this.validateProjectId(projectId);
    this.requireSameOrigin(origin);
    this.validateKey(key);
    if (!(await this.repository.hasOwnedProject(userId, projectId))) throw new NotFoundException();
    if (!(await this.repository.delete(userId, projectId, key))) throw new NotFoundException();
    return { deleted: true };
  }

  private requireSameOrigin(value: string | undefined): void {
    if (value === undefined) throw new BadRequestException("Same-origin request required");
    try {
      const url = new URL(value);
      if (
        url.origin !== this.publicOrigin ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      )
        throw new Error();
    } catch {
      throw new BadRequestException("Same-origin request required");
    }
  }

  private validateProjectId(value: string): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
      throw new BadRequestException("projectId must be a UUID");
    }
  }

  private validateKey(value: string): void {
    if (!KEY_PATTERN.test(value))
      throw new BadRequestException("key must be a Kubernetes environment identifier");
  }
}

function parseValue(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) {
    throw new BadRequestException("body must contain only a string value");
  }
  const value = (body as Record<string, unknown>).value;
  if (typeof value !== "string" || value.includes("\0"))
    throw new BadRequestException("value must be a valid string");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_VALUE_BYTES)
    throw new BadRequestException("value must not exceed 16384 UTF-8 bytes");
  return value;
}
