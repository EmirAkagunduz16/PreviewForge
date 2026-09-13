# Codex Çalışma Protokolü

PreviewForge üzerinde çalışırken bu protokol uygulanır. Kullanıcı talimatları ve repository'nin güvenlik/mimari kuralları önceliklidir.

## 1. Çalışma kapsamı

Görev başlamadan önce ilgili dosyaları belirle. Gereksiz dosyaları gezme veya değiştirme. Görev için gerekli olmayan refactor yapma. Bir dosyanın değiştirilmesi gerekip gerekmediğinden emin değilsen önce incele, sonra karar ver.

## 2. Dosya değiştirme sınırları

Sadece görevle doğrudan ilişkili dosyalara dokun. Görev dışı bir problem fark edersen düzeltme; bildir ve ayrı bir görev olarak öner.

## 3. Bitiş kriteri

Kod yazmadan önce görev tamamlandığında hangi koşulların doğru olacağını netleştir: ilgili davranış çalışmalı, mevcut davranış bozulmamalı ve uygun test/typecheck/lint/build kontrolleri geçmeli. Önemli mimari veya ürün kararlarında belirsizliği kullanıcıya sor.

## 4. Doğrulama

Kod değişikliğinden sonra göreve uygun minimum doğrulamayı çalıştır. Sadece kodu yazıp tamamlandı deme. Tamamlanan değişikliklerde, riskle orantılı olarak test, typecheck, lint ve build sonuçlarını belirt.

## 5. Görev bitiş raporu

Tamamlanan her görevde kısa olarak şunları bildir:

1. Ne değişti?
2. Hangi doğrulama komutları çalıştırıldı?
3. Sonuç neydi?
4. Bilinen eksik veya risk var mı?

## 6. İkinci review geçişi

Önemli değişikliklerde implementasyondan sonra ikinci bir review yap. Edge case, error handling, security, type safety, mevcut davranışın korunması ve gereksiz complexity kontrol edilir. Authentication, migration, deployment veya architecture değişikliklerinde mümkünse bağımsız temiz bir Codex oturumundan review alınır. Küçük ve düşük riskli değişikliklerde ayrı review zorunlu değildir.

## 7. Belirsizlik yönetimi

Küçük ve geri alınabilir kararlarda makul varsayımla ilerle. Önemli belirsizliklerde kullanıcıya sor. Varsayım yapıldıysa bitiş raporunda `Varsayımlar` başlığı altında belirt.

## 8. Davranış değişikliği dokümantasyonu

Bir değişiklik API davranışını, mimariyi, geliştirme workflow'unu veya önemli bir proje kuralını değiştiriyorsa ilgili dokümantasyonu da güncelle.

## 9. Küçük ve bağımsız değişiklikler

Değişiklikleri mantıksal olarak küçük ve bağımsız tut. Bir görev sırasında bağımsız büyük değişiklikleri karıştırma. Görev tamamlanmış, doğrulanmış ve kapsamı temizse agent kendi inisiyatifiyle yalnızca ilgili dosyaları commit edebilir; commit hash’ini görev raporunda belirtmelidir. Push yapmak için hâlâ kullanıcının açık izni gerekir.

## 10. Kapsam dışı sorunlar

Görev dışında fark edilen sorunları düzeltme. Bunun yerine `Ek olarak fark ettim: ...` şeklinde bildir ve ayrı görev olarak öner.

## 11. Oturum sonu özeti

Uzun çalışma oturumlarında şunları özetle:

- Ne yaptık?
- Proje şu anda hangi durumda?
- Sıradaki mantıklı adım ne?
