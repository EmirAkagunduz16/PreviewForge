import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "./dashboard.service.js";
import type { DashboardRepositoryPort } from "./dashboard.types.js";

describe("DashboardService", () => {
  it("authenticates every query, applies bounded defaults, and encodes stable cursors", async () => {
    const auth = { authenticate: vi.fn(async () => ({ userId: "owner-a" })) };
    const repository = fakeRepository();
    repository.listProjects.mockResolvedValue({
      items: [{ id: "project-a" }],
      nextCursor: {
        id: "123e4567-e89b-12d3-a456-426614174000",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const service = new DashboardService(auth, repository);

    const result = await service.listProjects("session", {});
    expect(auth.authenticate).toHaveBeenCalledWith("session");
    expect(repository.listProjects).toHaveBeenCalledWith("owner-a", { limit: 20 });
    expect(result.items).toEqual([{ id: "project-a" }]);
    expect(result.nextCursor).toBe(
      Buffer.from(
        JSON.stringify({
          id: "123e4567-e89b-12d3-a456-426614174000",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toString("base64url"),
    );

    await service.listProjects("session", { limit: "100", cursor: result.nextCursor });
    expect(repository.listProjects).toHaveBeenLastCalledWith("owner-a", {
      limit: 100,
      cursor: {
        id: "123e4567-e89b-12d3-a456-426614174000",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
  });

  it.each([{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { cursor: "not-a-cursor" }])(
    "rejects invalid pagination input %#",
    async (query) => {
      const service = new DashboardService(
        { authenticate: vi.fn(async () => ({ userId: "owner-a" })) },
        fakeRepository(),
      );
      await expect(service.listProjects("session", query)).rejects.toMatchObject({ status: 400 });
    },
  );

  it("scopes child reads to authenticated ownership and makes hidden/missing resources 404", async () => {
    const auth = { authenticate: vi.fn(async () => ({ userId: "owner-a" })) };
    const repository = fakeRepository();
    const service = new DashboardService(auth, repository);
    const projectId = "123e4567-e89b-12d3-a456-426614174000";

    repository.hasOwnedProject.mockResolvedValue(false);
    await expect(service.listPreviews("session", projectId, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.listDeployments("session", projectId, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.hasOwnedProject).toHaveBeenCalledWith("owner-a", projectId);
    expect(repository.listPreviews).not.toHaveBeenCalled();
    expect(repository.listDeployments).not.toHaveBeenCalled();

    repository.findDeployment.mockResolvedValue(null);
    await expect(
      service.getDeployment("session", "123e4567-e89b-12d3-a456-426614174001"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findDeployment).toHaveBeenCalledWith(
      "owner-a",
      "123e4567-e89b-12d3-a456-426614174001",
    );
  });

  it("adds the same local preview URL to environment and deployment projections", async () => {
    const auth = { authenticate: vi.fn(async () => ({ userId: "owner-a" })) };
    const repository = fakeRepository();
    const environmentId = "123e4567-e89b-12d3-a456-426614174000";
    const deploymentId = "123e4567-e89b-12d3-a456-426614174001";
    repository.listPreviews.mockResolvedValue({
      items: [{ id: environmentId, currentDeployment: { id: deploymentId } }],
      nextCursor: null,
    });
    repository.listDeployments.mockResolvedValue({
      items: [{ id: deploymentId, environment: { id: environmentId } }],
      nextCursor: null,
    });
    repository.findDeployment.mockResolvedValue({
      id: deploymentId,
      environment: { id: environmentId },
    });
    const service = new DashboardService(auth, repository, {
      baseDomain: "preview.localhost",
      scheme: "http",
      localPort: 18080,
    });
    const url = `http://preview-${environmentId}.preview.localhost:18080/`;

    await expect(service.listPreviews("session", environmentId, {})).resolves.toMatchObject({
      items: [
        {
          previewUrl: url,
          currentDeployment: { id: deploymentId, previewUrl: url },
        },
      ],
    });
    await expect(service.listDeployments("session", environmentId, {})).resolves.toMatchObject({
      items: [{ previewUrl: url, environment: { id: environmentId, previewUrl: url } }],
    });
    await expect(service.getDeployment("session", deploymentId)).resolves.toEqual({
      id: deploymentId,
      previewUrl: url,
      environment: { id: environmentId, previewUrl: url },
    });
  });
});

function fakeRepository(): DashboardRepositoryPort & {
  hasOwnedProject: ReturnType<typeof vi.fn>;
  listProjects: ReturnType<typeof vi.fn>;
  listPreviews: ReturnType<typeof vi.fn>;
  listDeployments: ReturnType<typeof vi.fn>;
  findDeployment: ReturnType<typeof vi.fn>;
} {
  return {
    hasOwnedProject: vi.fn(async () => true),
    listProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
    listPreviews: vi.fn(async () => ({ items: [], nextCursor: null })),
    listDeployments: vi.fn(async () => ({ items: [], nextCursor: null })),
    findDeployment: vi.fn(async () => null),
  };
}
