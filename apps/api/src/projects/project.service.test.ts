import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../github/github-client.js";
import type { ProjectImportError } from "./project.errors.js";
import { ProjectService } from "./project.service.js";
import type {
  ProjectAuthPort,
  ProjectCredentialCipher,
  ProjectGitHubPort,
  ProjectInstallationPort,
  ProjectRepositoryCandidate,
  ProjectRepositoryPort,
} from "./project.types.js";

const session = { userId: "user-1" };
const installation = {
  id: "installation-row-1",
  githubInstallationId: "42",
  githubAccountId: "10",
  accountLogin: "octo",
  accountType: "User",
  ownerId: "user-1",
};

describe("ProjectService", () => {
  it("lists all user-authorized repository pages and never returns the user token", async () => {
    const github = fakeGithub([
      repository("101", "octo/first"),
      repository("102", "octo/second"),
      repository("103", "octo/third"),
    ]);
    const service = createService(github);

    const result = await service.listRepositories("session-token", "42");

    expect(result.map((item) => item.fullName)).toEqual([
      "octo/first",
      "octo/second",
      "octo/third",
    ]);
    expect(github.listUserInstallationRepositories).toHaveBeenCalledWith("42", "user-token");
    expect(JSON.stringify(result)).not.toContain("user-token");
  });

  it("rejects inaccessible pull=false repositories before creating an installation token", async () => {
    const github = fakeGithub([repository("101", "octo/example", { pull: false })]);
    const service = createService(github);

    await expect(service.importProject("session-token", importRequest())).rejects.toMatchObject<
      Partial<ProjectImportError>
    >({
      code: "REPOSITORY_NOT_ACCESSIBLE",
    });
    expect(github.createInstallationToken).not.toHaveBeenCalled();
  });

  it.each([
    ["stale full name", { repositoryFullName: "octo/renamed" }, "REPOSITORY_IDENTITY_CONFLICT"],
    ["spoofed numeric ID", { repositoryId: "999" }, "REPOSITORY_NOT_ACCESSIBLE"],
  ] as const)("rejects %s without checking repository contents", async (_label, change, code) => {
    const github = fakeGithub([repository("101", "octo/example")]);
    const service = createService(github);

    await expect(
      service.importProject("session-token", importRequest(change)),
    ).rejects.toMatchObject({
      code,
    });
    expect(github.createInstallationToken).not.toHaveBeenCalled();
    expect(github.getRepositoryContent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing dockerfile", undefined],
    ["directory dockerfile", []],
    ["non-file dockerfile", { type: "symlink", path: "Dockerfile" }],
    ["spoofed content path", { type: "file", path: "other/Dockerfile" }],
  ] as const)("rejects %s and does not persist a project", async (_label, content) => {
    const github = fakeGithub([repository("101", "octo/example")]);
    if (content === undefined) {
      github.getRepositoryContent = vi.fn(async () => {
        throw new GitHubApiError(404, "not_found", false);
      });
    } else {
      github.getRepositoryContent = vi.fn(
        async () =>
          content as { type: string; path: string } | Array<{ type: string; path: string }>,
      );
    }
    const projects = fakeProjects();
    const service = createService(github, projects);

    const contentType =
      content !== undefined && !Array.isArray(content)
        ? (content as { type: string }).type
        : undefined;
    const expectedCode =
      content === undefined
        ? "DOCKERFILE_NOT_FOUND"
        : Array.isArray(content)
          ? "DOCKERFILE_NOT_FILE"
          : contentType === "file"
            ? "DOCKERFILE_PATH_MISMATCH"
            : "DOCKERFILE_NOT_FILE";
    await expect(service.importProject("session-token", importRequest())).rejects.toMatchObject({
      name: "ProjectImportError",
      code: expectedCode,
    });
    expect(projects.importProject).not.toHaveBeenCalled();
  });

  it("maps an upstream Dockerfile error to a stable redacted code", async () => {
    const github = fakeGithub([repository("101", "octo/example")]);
    github.getRepositoryContent = vi.fn(async () => {
      throw new Error("upstream leaked installation-token");
    });
    const projects = fakeProjects();
    const service = createService(github, projects);

    await expect(service.importProject("session-token", importRequest())).rejects.toMatchObject({
      name: "ProjectImportError",
      code: "DOCKERFILE_CHECK_FAILED",
      message: "Dockerfile could not be verified",
    });
    try {
      await service.importProject("session-token", importRequest());
    } catch (error) {
      expect(error).toMatchObject({ message: "Dockerfile could not be verified" });
      expect(String(error)).not.toContain("installation-token");
    }
    expect(projects.importProject).not.toHaveBeenCalled();
  });

  it("rejects a wrong-owner installation before making a GitHub call", async () => {
    const github = fakeGithub([repository("101", "octo/example")]);
    const service = createService(github, fakeProjects(), { ownerId: "different-user" });

    await expect(service.importProject("session-token", importRequest())).rejects.toMatchObject({
      status: 401,
      message: "Installation access required",
    });
    expect(github.listUserInstallationRepositories).not.toHaveBeenCalled();
    expect(github.createInstallationToken).not.toHaveBeenCalled();
  });

  it.each([
    ["port", { port: 0 }],
    ["dockerfile traversal", { dockerfilePath: "../Dockerfile" }],
    ["health URL", { healthPath: "https://internal" }],
  ] as const)("rejects unsafe %s configuration before GitHub calls", async (_label, change) => {
    const github = fakeGithub([repository("101", "octo/example")]);
    const service = createService(github);

    await expect(service.importProject("session-token", importRequest(change))).rejects.toThrow(
      /invalid project import request/i,
    );
    expect(github.listUserInstallationRepositories).not.toHaveBeenCalled();
    expect(github.createInstallationToken).not.toHaveBeenCalled();
  });

  it("revalidates access, uses an installation token only for contents, and persists no token", async () => {
    const github = fakeGithub([repository("101", "octo/example")]);
    const projects = fakeProjects();
    const service = createService(github, projects);

    const result = await service.importProject("session-token", importRequest());

    expect(github.listUserInstallationRepositories).toHaveBeenCalledWith("42", "user-token");
    expect(github.createInstallationToken).toHaveBeenCalledWith("42");
    expect(github.getRepositoryContent).toHaveBeenCalledWith(
      "octo",
      "example",
      "Dockerfile",
      "installation-token",
    );
    expect(projects.importProject).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepositoryId: "101",
        repositoryFullName: "octo/example",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("installation-token");
    expect(JSON.stringify(projects.importProject.mock.calls[0]?.[0])).not.toContain(
      "installation-token",
    );
  });
});

function createService(
  github: ProjectGitHubPort,
  projects: ProjectRepositoryPort = fakeProjects(),
  installationOverride: Partial<typeof installation> = {},
): ProjectService {
  const auth: ProjectAuthPort = { authenticate: vi.fn(async () => session) };
  const installations: ProjectInstallationPort = {
    findInstallation: vi.fn(async () => ({ ...installation, ...installationOverride })),
    getCredential: vi.fn(async () => ({ encryptedAccessToken: "v1.ciphertext" })),
  };
  const cipher: ProjectCredentialCipher = {
    decrypt: vi.fn(() => "user-token"),
  };
  return new ProjectService(auth, installations, github, projects, cipher);
}

function fakeGithub(repositories: ProjectRepositoryCandidate[]): ProjectGitHubPort & {
  listUserInstallationRepositories: ReturnType<typeof vi.fn>;
  createInstallationToken: ReturnType<typeof vi.fn>;
  getRepositoryContent: ReturnType<typeof vi.fn>;
} {
  return {
    listUserInstallationRepositories: vi.fn(async () => repositories),
    createInstallationToken: vi.fn(async () => ({ accessToken: "installation-token" })),
    getRepositoryContent: vi.fn(async () => ({ type: "file", path: "Dockerfile" })),
  };
}

function fakeProjects(): ProjectRepositoryPort & { importProject: ReturnType<typeof vi.fn> } {
  return {
    importProject: vi.fn(async (input) => ({
      id: "project-1",
      installationId: input.installationId,
      ownerId: input.ownerId,
      githubRepositoryId: input.githubRepositoryId,
      repositoryFullName: input.repositoryFullName,
      defaultBranch: input.defaultBranch ?? "main",
      dockerfilePath: input.dockerfilePath,
      containerPort: input.containerPort,
      healthPath: input.healthPath,
    })),
  };
}

function repository(
  id: string,
  fullName: string,
  options: { pull?: boolean } = {},
): ProjectRepositoryCandidate {
  return { id, fullName, ...(options.pull === undefined ? {} : { pull: options.pull }) };
}

function importRequest(change: Record<string, unknown> = {}) {
  return {
    installationId: "42",
    repositoryId: "101",
    repositoryFullName: "octo/example",
    dockerfilePath: "Dockerfile",
    port: 3000,
    healthPath: "/",
    ...change,
  };
}
