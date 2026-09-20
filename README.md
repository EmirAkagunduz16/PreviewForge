# PreviewForge

PreviewForge, GitHub pull request'lerine geçici ve izole preview ortamı oluşturan
self-hosted bir geliştirici platformudur. Vercel veya Netlify'daki preview
fikrini kendi bilgisayarımızdaki Docker, rootless BuildKit ve Kubernetes kind
üzerinde çalıştırır.

Bir pull request açıldığında PreviewForge repository'deki Dockerfile'ı build
eder, image'ı değişmez bir digest ile registry'ye gönderir, kind cluster içinde
ayrı bir namespace oluşturur ve preview URL'sini hem dashboard'da hem de
GitHub Check'te gösterir. Pull request kapandığında bu preview kaynakları
silinir.

## Kısa durum özeti

- **Local ürün:** M9 tamamlandı. Local runtime, browser onboarding/import,
  gerçek rootless BuildKit build/push, kind/Envoy routing, live logs ve close
  cleanup gerçek bağımlılıklarla doğrulandı.
- **Kod ve rapor:** Son doğrulanmış commit push edildi; ayrıntılı kanıt
  [M9 local product acceptance report](docs/reports/session-2026-09-20-m9-local-product.md)
  içinde.
- **Sıradaki roadmap maddesi:** `The repository is in M10`; bu AWS EKS/ECR
  cloud demo'sudur ve açık bütçe/onay sınırı nedeniyle `blocked` durumundadır.
  Local M9'da zorunlu kalan iş yok.
- **Korunan sınır:** AWS hesabı, gerçek GitHub credential'ı veya production
  kaynağı local kabul için kullanılmadı.

## Bunu nasıl düşünmelisin?

PreviewForge'u dört parçalı bir üretim hattı gibi düşünebilirsin:

1. **GitHub olayı gelir.** Pull request açıldı veya yeni commit geldi bilgisi
   API'ye ulaşır.
2. **API işi kaydeder.** İmza doğrulanır, aynı teslimat ikinci kez gelirse
   deduplicate edilir ve PostgreSQL'e kalıcı bir deployment isteği yazılır.
3. **Worker işi yürütür.** Kaynağı alır, rootless BuildKit ile Dockerfile'ı
   build/push eder, digest'i çözer ve Kubernetes kaynaklarını uygular.
4. **Kullanıcı preview'ı açar.** Envoy Gateway doğru hostname'i ilgili
   namespace'e yönlendirir; health check başarılıysa deployment `READY` olur.

Bir pull request'in yeni commit'i geldiğinde eski build yeni commit'in önüne
geçemez. Pull request kapanınca worker namespace'i sahiplik kontrolüyle siler.

## Hangi parça ne işe yarıyor?

| Parça | Görevi | Neden var? |
|---|---|---|
| `apps/web` | Next.js dashboard | Sign-in, repository import, deployment history, stage ve log ekranı |
| `apps/api` | NestJS control plane | Auth, GitHub App callback/webhook, project ayarları, dashboard API ve SSE |
| PostgreSQL | Kalıcı gerçek kaynak | Kullanıcı, project, PR, desired SHA, deployment, log, outbox ve cleanup kayıtları |
| Kafka | Event taşıma katmanı | API ile worker arasındaki at-least-once mesaj akışı |
| `apps/worker` | Asenkron orkestratör | Source alma, BuildKit, registry, Kubernetes rollout, health check ve cleanup |
| Rootless BuildKit | Dockerfile build motoru | Kullanıcı kodunu Docker socket veya privileged mod olmadan build etmek |
| Local OCI registry | Image deposu | kind'ın çekebileceği image manifest ve layer'larını tutmak |
| kind + Kubernetes | Preview runtime | Her preview için namespace, Deployment, Service ve HTTPRoute çalıştırmak |
| Envoy Gateway | HTTP routing | `preview-<environment-id>.preview.localhost` hostname'ini doğru preview'a yönlendirmek |
| GitHub fixture | Kontrollü test GitHub'ı | Gerçek hesap/credential olmadan OAuth, repository, source ve webhook journey çalıştırmak |

PostgreSQL durumun kaynağıdır. Kafka yalnızca mesajı taşır; Kafka offset'i tek
başına deployment'ın varlığı olarak kabul edilmez.

## Pull request'ten preview'a akış

```text
GitHub pull_request webhook
        |
        v
API: raw HMAC doğrula + delivery dedupe
        |
        v
PostgreSQL: desired SHA + deployment + outbox
        |
        v
Outbox relay -> Kafka -> Worker
                         |
                         +-> kısa ömürlü GitHub installation token ile source al
                         +-> rootless BuildKit build/push
                         +-> immutable image digest kaydet
                         +-> kind/Kubernetes kaynaklarını uygula
                         +-> Envoy üzerinden health check yap
                         |
                         v
                 READY + dashboard SSE + GitHub Check
```

Deployment stage'leri sırayla şöyledir:

`QUEUED -> CLONING -> BUILDING -> PUSHING -> DEPLOYING -> WAITING_FOR_HEALTHCHECK -> READY`

Bir hata `FAILED`, daha yeni commit eski işi geçersiz kılarsa `SUPERSEDED`,
kontrollü durdurma gerekiyorsa `CANCELLED` olur. Terminal durumlar geriye
çevrilmez.

## Local olarak çalıştırma

### Gereksinimler

- Node.js 22
- pnpm 10
- Docker + Docker Compose
- `kubectl`
- `kind`
- Ayrı kullanıcı altında çalışan rootless BuildKit ve Unix socket

Önce host'u kontrol et:

```bash
pnpm install
pnpm run doctor
```

Rootless BuildKit'in kurulumu, socket yetkilendirmesi ve kind registry bağlantısı
[M4 rootless BuildKit dokümanında](docs/infrastructure/m4-rootless-buildkit.md)
ve [local development runbook'unda](docs/operations/local-development.md)
anlatılıyor. Bu sınır özellikle korunuyor: Docker socket, TCP BuildKit,
`--privileged`, host networking veya global AppArmor/sysctl gevşetmesi yok.

### Runtime

```bash
cp .env.example .env
pnpm local:up
```

Başka bir terminalde:

```bash
pnpm local:status
pnpm local:down
```

`local:up` şunları yapar:

1. Docker context, BuildKit socket, kind ve Gateway önkoşullarını kontrol eder.
2. PostgreSQL, Kafka ve local registry'yi başlatır veya yeniden kullanır.
3. Database migration'larını uygular.
4. kind cluster, Envoy Gateway ve platform Gateway'i hazırlar.
5. Registry'yi kind'a bağlar ve Gateway port-forward başlatır.
6. API, worker ve web süreçlerini başlatır.
7. API, worker health ve dashboard hazır olmadan `ready` mesajı vermez.

### Local adresler

| Adres | Ne gösterir? |
|---|---|
| <http://localhost:3000> | Dashboard |
| <http://localhost:4000/health> | API health |
| `localhost:55432` | PostgreSQL |
| `localhost:59092` | Kafka |
| `localhost:55000` | Local OCI registry |
| `http://127.0.0.1:18080` | Envoy loopback Gateway |
| `http://preview-<environment-id>.preview.localhost:18080/` | READY preview |

Preview URL'sindeki hostname HTTPRoute kimliğidir. `18080` yalnızca local
Gateway port-forward'ıdır.

### Kontrollü GitHub journey

Gerçek GitHub hesabı kullanmadan acceptance çalıştırmak için:

```bash
pnpm m9:fixture:check
pnpm m9:github-fixture
```

Fixture yalnızca `127.0.0.1:43129` üzerinde çalışır. Ayrıntılı credential'sız
kurulum ve lifecycle komutları
[local GitHub App runbook'unda](docs/operations/local-github-app.md) bulunur.

## Güvenlik sınırları

- Webhook HMAC'i parse edilmiş JSON'a değil, **ham request body**'ye uygulanır.
- `X-GitHub-Delivery` ile duplicate webhook'lar güvenli şekilde yok sayılır.
- Her deployment kendi commit SHA'sını taşır; desired SHA değişirse eski iş
  `SUPERSEDED` olur.
- GitHub installation token'ı source alma sırasında kullanılır; build context,
  image layer, preview environment veya log'a sokulmaz.
- Build rootless BuildKit ile çalışır; worker Docker socket'e erişmez.
- Kubernetes preview'ları namespace, quota, limit, default-deny network policy,
  disabled service-account token automount ve ownership/expiry metadata ile
  oluşturulur.
- Image tag yerine immutable digest deploy edilir.
- Environment variable değerleri şifreli ve write-only'dir; API bunları geri
  döndürmez.
- Cleanup aynı isteğin tekrar gelmesine dayanıklıdır; orphan reconciler kaçan
  kaynakları arar.

## v1 kapsamı ve sınırları

Desteklenenler:

- GitHub App ve pull request event'leri
- Bir repository, bir Dockerfile, bir HTTP container
- PR başına tek desired preview environment
- Configurable container port ve health path
- Şifreli write-only environment variables
- Deployment history, live logs ve GitHub Check
- PR close ve TTL cleanup
- Önceden hazırlanmış tek Kubernetes cluster ve registry

Bu sürümün hedefi olmayanlar:

- AWS cloud deployment (M10, şimdilik bloklu)
- GitLab veya Bitbucket
- Multi-container Compose tanımı
- User database, Redis, persistent volume veya cluster provisioning
- Production deployment, custom domain, billing veya enterprise RBAC
- Arbitrary Helm chart/Kubernetes manifest
- Hostile public multi-tenant izolasyonu

## Repository haritası

```text
apps/web/                 Dashboard
apps/api/                 Auth, webhook, project ve query API
apps/worker/              Build, deploy, health, logs ve cleanup worker'ı
packages/contracts/       Zod/domain/Kafka/preview URL sözleşmeleri
packages/database/        Prisma schema, migration ve repository'ler
packages/security/        Credential encryption
packages/observability/   Metrics, traces ve telemetry
infrastructure/local/     PostgreSQL, Kafka, registry Compose tanımı
infrastructure/kubernetes/ kind + Gateway kaynakları
scripts/local/            local:up/status/down supervisor'ı
scripts/m9/               Controlled GitHub fixture ve journey runner
fixtures/m9/              Deterministic source, webhook ve journey girdileri
docs/architecture/        Sistem tasarımı ve ADR'ler
docs/plans/               Milestone execution contract'ları
docs/reports/             Doğrulanmış teknik ve acceptance raporları
docs/backlog/             Aktif ve tamamlanmış iş kaydı
```

## Doğrulama

Tam repository quality gate:

```bash
set -a; source .env; set +a
pnpm check
```

Bu komut Biome, Markdown/context consistency, typecheck, unit test, build ve
PostgreSQL/Kafka integration test'lerini çalıştırır. Local M9 kabulünün ayrıntılı
kanıtları [teknik raporda](docs/reports/lesson-2026-09-20-previewforge-technical-overview.md)
ve [M9 acceptance raporunda](docs/reports/session-2026-09-20-m9-local-product.md)
var.

## Daha fazla okuma

- [MVP kapsamı](docs/product/mvp-scope.md)
- [Sistem tasarımı](docs/architecture/system-design.md)
- [Local development runbook](docs/operations/local-development.md)
- [M9 local GitHub runbook](docs/operations/local-github-app.md)
- [Roadmap](docs/delivery/roadmap.md)
- [Active backlog](docs/backlog/active.md)
- [Project memory](docs/knowledge/previewforge-memory.md)
