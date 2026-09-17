---
id: RPT-2026-09-17-m7-ttl-orphan
type: session
status: verified
date: 2026-09-17
vault_sync: not-yet-synced
---

# M7 TTL ve orphan cleanup — 2026-09-17

## Result

M7-TTL ve M7-ORPHAN tamamlandı. TTL artık kabul edilen webhook transaction'ında
atanıyor/yenileniyor, süresi dolan aktif preview aynı durable deletion intent
üzerinden worker tarafından temizleniyor ve reconciler yalnızca güvenli biçimde
kimliği doğrulanmış PreviewForge Kubernetes namespace orphan'larını siliyor.
M7-PR-CLOSE regresyonu da bu değişikliklerden sonra yeniden geçti. Birleştirilmiş
M7 kabul turu hâlâ M7-ACCEPTANCE olarak açık.

## Implementation evidence

- `PREVIEW_TTL_SECONDS` varsayılanı 24 saat, üst sınırı 31 gün olacak şekilde API
  config'e eklendi. Kabul edilen open/synchronize olayları aynı environment'ın
  `expiresAt` değerini yeniliyor; Kubernetes annotation'ı PostgreSQL'deki
  authoritative expiry ile eşleşiyor.
- `EnvironmentDeletionRepository.enqueueExpired` PostgreSQL satır kilidi,
  `SKIP LOCKED`, bounded batch ve environment başına durable idempotency ile
  yalnızca süresi dolmuş `ACTIVE` environment'lar için `ttl_expired` intent'i
  üretiyor. TTL event'i PR açıkken de cleanup coordinator'a girebiliyor; close
  event'i için mevcut CLOSED guard korunuyor.
- `EnvironmentDeletionRequest.reason` için
  `packages/database/prisma/migrations/20260917120000_m7_cleanup/` migration'ı
  uygulandı. Close ve TTL nedenleri outbox payload'ında ayırt ediliyor.
- Worker'da bounded interval TTL sweeper eklendi; sweeper Kubernetes'e doğrudan
  dokunmuyor ve mevcut deletion consumer/coordinator yolunu kullanıyor.
- Orphan reconciler yalnızca `previewforge.dev/managed=true` namespace'lerini
  bounded pagination ile listeliyor; UUID-derived isim, environment/project
  ownership label'ları ve PostgreSQL durumu doğrulanmadan silme çağrısı yapmıyor.
  DB kaydı olmayan veya terminal cleanup durumundaki namespace'ler uygun aday;
  aktif, malformed, yanlış owner'lı ve yarışta UID/resourceVersion değişmiş
  kaynaklar güvenli biçimde atlanıyor.

## Runtime acceptance

Yerel PostgreSQL, Kafka ve `kind-previewforge` üzerinde:

```text
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public KAFKA_BROKERS=localhost:59092 pnpm --filter @previewforge/worker exec vitest run src/cleanup/ttl-sweeper.acceptance.test.ts --no-file-parallelism
```

Sonuç: 1 dosya / 2 test geçti. Süresi dolmuş environment bir kez intent üretip
aynı deletion yolundan silindi; gelecek expiry canlı kaldı ve annotation zamanı
DB ile eşleşti.

```text
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public pnpm --filter @previewforge/worker exec vitest run src/cleanup/orphan-reconciler.acceptance.test.ts --no-file-parallelism
```

Sonuç: 1 test geçti. DB kaydı olmayan geçerli orphan silindi; malformed,
unowned ve wrong-owner namespace'ler korundu/skip edildi.

```text
DATABASE_URL=postgresql://previewforge:previewforge@localhost:55432/previewforge?schema=public KAFKA_BROKERS=localhost:59092 pnpm --filter @previewforge/worker exec vitest run src/cleanup/environment-deletion.acceptance.test.ts --no-file-parallelism
```

Sonuç: 1 dosya / 2 test geçti. PR-close deletion akışı TTL değişikliğinden sonra
da owned namespace, tekrar delivery ve wrong-owner guard davranışını korudu.

## Repository verification

- Migration deploy başarılı: `20260917120000_m7_cleanup`.
- Worker unit: 25 dosya / 205 test geçti.
- Database TTL/deletion integration: 15 test; M2 migration regression: 4 test
  geçti.
- Worker gerçek Kafka/PostgreSQL M3 integration: 1 dosya / 5 test geçti.
- API integration, dosyalar arası timestamp fixture yarışını ayırmak için
  `--no-file-parallelism` ile: 5 dosya / 6 test geçti.
- `pnpm docs:check`: 230 local Markdown link, 62 dosya; 8 roadmap milestone,
  7 plan ve 3 active backlog entry tutarlı.
- `git diff --check` ve ilgili Biome kontrolü geçti. Temiz runtime durumundan
  tam `pnpm check` geçti: Biome 197 dosya, `docs:check` 230 link/62 dosya,
  Turbo 18/18, database integration 14 dosya/98 test, API integration 5
  dosya/6 test ve worker M3 integration 1 dosya/5 test; tüm typecheck ve
  build adımları da başarılı. TTL database integration teardown'ı outbox
  event'lerini de temizliyor; böylece cleanup acceptance residue'i sonraki
  worker integration'a sızmıyor.

## Residue and limits

- `kind-previewforge` içinde `previewforge.dev/managed=true` namespace kalmadı.
- M3/M6/M7 disposable kullanıcı, installation, project ve preview environment
  satırı; publish edilmemiş outbox satırı; yeni M7 Kafka delivery satırı ve
  acceptance süreci kalmadı.
- 2026-09-14 tarihli iki eski M3 dead-letter delivery kaydı mevcut; bunlar bu
  çalışmanın fixture'ı değil ve korunmuştur.
- Compose PostgreSQL/Kafka/registry ve kind cluster çalışma ortamı olarak açık
  kaldı; bunlar acceptance sürecinden kalan process değil, mevcut disposable
  runtime servisleridir.
- `.git` filesystem'i read-only olduğu için commit oluşturulamadı; push
  yapılmadı.

## Links

- [M7 execution contract](../plans/m7-github-feedback-cleanup.md#M7-TTL)
- [Active backlog](../backlog/active.md)
- [M7 PR-CLOSE report](session-2026-09-17-m7-pr-close.md)
