# Türkiye il merkezleri — resmî namaz vakitleri

81 il merkezi için Diyanet İşleri Başkanlığı Awqat Salah servisinden alınan, doğrulanmış takvimlerin açık veri kopyasıdır. Resmî bir Diyanet uygulaması/deposu değildir. İlçeleri kapsamaz.

Veri kaynağı: https://awqatsalah.diyanet.gov.tr/
Resmî takvim: https://namazvakitleri.diyanet.gov.tr/

## Kullanım

`public/v1/prayer-times/{cityId}.json` — İstanbul saat diliminde Sabah (imsak), Öğle, İkindi, Akşam, Yatsı. İl anahtarları ve resmî merkez eşleştirmeleri `config/cities.json` dosyasındadır.

Ham dosya kökü: `https://raw.githubusercontent.com/MustafaGokbasi/vaktinde-prayer-data/main/public`
Her dosyada kaynak, son alınma zamanı ve kapsanan tarih aralığı bulunur. Önbellekte saklayın; günde birden sık indirmeyin. GitHub erişilebilirlik garantisi vermez. Eksik tarihler için resmî veri varmış gibi hesaplanmış saat üretmeyin.

## Güncelleme

GitHub Actions her gün yaklaşık 06:23 Türkiye saatinde kontrol eder. **Geçici kontrollü geçiş yalnız Antalya'yı etkinleştirir**; diğer 80 şehrin dosyaları korunur. Antalya için bir kalıcı deneme kaydı oluşturulduktan sonra sonraki zamanlanmış/elle başlatılmış işler API'ye çıkmadan durur. İlk denemede yedi günden eski veya kapsamı yetersiz Antalya dosyası yenilenir. GitHub zamanlanmış işleri geciktirebilir. Üretim aralığı Ekimden itibaren gelecek yılın sonuna kadardır; bunun canlı karşılandığı henüz doğrulanmadı. Kota ve veri yapısı değişirse sistem durur ve son doğrulanmış dosyalar korunur.

Diyanet hesabı yalnız Actions Secrets üzerinden `DIYANET_EMAIL` ve `DIYANET_PASSWORD` ile kullanılır. Depoya hiçbir parola, erişim belirteci, uygulama kaynak kodu veya kişisel namaz kaydı konulmaz. İş sadece bu deponun ana dalında zamanlanmış/elle başlatılmış olarak çalışır; dış katkı istekleri iş tetiklemez.

`state/ledger.json` kişisel veri içermez: yer kimliği başına aylık istek sayılarıdır. Her istekten ÖNCE GitHub'a kaydedilir. Başarısız/yarım kalan istekler de sayılır; aylık 10 istek/merkez sınırı uygulanır. Bu sayaç silinmemeli veya sıfırlanmamalıdır. Başka yerden yapılan ek API çağrıları da sayaca eklenmelidir; eşzamanlı ayrı indirici çalıştırmayın.

Güncelleme hataları Actions sayfasından ve hesap sahibinin GitHub bildirimlerinden izlenmelidir. GitHub, 60 gün faaliyet olmayan açık depolarda zamanlanmış işleri durdurabilir. Normal haftalık veri güncellemeleri depo faaliyetidir; uzun süreli hatalarda iş durumunu ve takvim kapsamını kontrol edin.

Başlangıç verisi 22 Eylül–31 Aralık 2026 aralığıdır. Gelecek tarihler sonraki başarılı yenilemelerle eklenir. Yayınlanan geçmiş sürümler Git geçmişinde korunur.

## Güvenli hata tanılaması

Başarısız güncellemeler stderr'e yalnız üç alan içeren bir JSON satırı yazar:
`failedStage` (başarısız işlem aşaması), `errorCode` (yerel izin listesindeki hata kodu)
ve `httpStatus` (varsa doğrulanmış sayısal HTTP durumu; yoksa `null`).
Git işlem çıkış kodu HTTP durumu olarak kullanılmaz. Ham hata metni/yığını, URL,
başlıklar, istek/yanıt gövdeleri ve kimlik bilgileri yazılmaz.

Örneğin `initial_quota_request / ACCESS_DENIED / 403` hesap erişimi isteğini,
`quota_validation / STAGE_FAILED / null` kota doğrulamasının durduğunu gösterir.
`STAGE_FAILED` tek başına ayrıntılı kök neden iddiası değildir. Bir yenileme hatasından
sonra geçerli takvimleri yayımlama da başarısız olursa iki güvenli kayıt yazılır;
ilk hata kaybolmaz. İş yine 1 çıkış koduyla durur, otomatik istek tekrarı yapılmaz.

## Kontroller

Node.js 24, haricî çalışma zamanı paketi gerekmez.

`node --test sync/*.test.mjs`

## 16 Ekim 2026 kota incelemesi ve Antalya denemesi hazırlığı

Hesap sahibinin 16 Ekim 2026 tarihinde yetkilendirdiği tarayıcıda aldığı
`Quota/My?includeUnused=true` yanıtı `Default` rolünü gösterdi. Politika bu
incelemeye göre aşağıdaki 13 grubun tam listesini bekler:

| Dönem | Controller / Result | Hak |
| --- | --- | --- |
| Daily | DailyContent / Get | 15 |
| Daily | Place / City, Country, GetAllCities, GetAllStates, State | Her biri 15 |
| Daily | Place / CityDetail | 10 |
| Daily | PrayerTime / PrayerTimeDaily | 15 |
| Daily | PrayerTime / PrayerTimeMonthly, PrayerTimeWeekly | Her biri 10 |
| Monthly | PrayerTime / PrayerTimeDateRange | 10 |
| Yearly | PrayerTime / PrayerTimeEid | 365 |
| Yearly | PrayerTime / PrayerTimeRamadan | 300 |

Weekly boştu. Kullanımı olan tek grup PrayerTimeDaily idi: toplam 1,
`cityId:17885` satırında 1 kullanım ve 14 kalan hak. Diğer gruplar sıfır
kullanımlı ve boş satırlıydı. Boş kullanım satırları sınırsız hak değildir.
Bu tarihi yanıt bir canlı yetki belgesi değildir; çalıştırma anında yeni
yanıtın beş dakikalık tazelik denetiminden geçmesi gerekir.

[Resmî belge](https://awqatsalah.diyanet.gov.tr/index.html) DateRange için yer
başına aylık 10 istek belirtir. Mevcut adaptör ayrıca **toplam kullanımı** da
sınırlar: toplam 9 ise sonraki isteğe izin verir, toplam 10 ise başka şehrin
kotası boş görünse bile durur. Bu muhafazakâr kısıt değiştirilmemiştir;
81 şehrin yenilenmesini aynı dönemde engelleyebilir.

Genel `runRefresh` fonksiyonunda `FORCE_CITY` yalnız yenilemeyi zorlar; tek başına
şehir filtresi değildir. Üretim runner'ı artık aşağıdaki sabit Antalya listesiyle
çağırır; bu kısıt `FORCE_CITY` davranışından bağımsızdır. İki günlük ayrı tarayıcı
denemesi için hazırlanan modül `sync/antalya-probe.mjs` içindeki
`runAntalyaProbe({ root, client, persistAccountLedger, now })` fonksiyonudur.
Modül içe aktarıldığında veya doğrudan çalıştırıldığında API çağrısı yapmaz;
kimlik doğrulama, canlı CLI ve workflow bağlantısı içermez. Bu aşamada yalnız
çevrimdışı testler çalıştırılmıştır.

Hazırlanan canlı denemenin kapsamı, ayrıca yetkilendirildiğinde:

- Eşleştirme `config/cities.json` içinden okunur; yalnız `antalya`, resmî şehir
  `9225`, il `507` kabul edilir. Şehir listesi/`FORCE_CITY` ile genişletilemez.
- Sabit aralık: **2026-10-16–2026-10-17**, iki gün, İstanbul yerel gece yarısı.
  En fazla bir `GET /api/Quota/My?includeUnused=true` ve kontroller geçerse
  en fazla bir `POST /api/PrayerTime/DateRange`; otomatik tekrar yoktur.
- `state/ledger.json` önceden mevcut olmalıdır. Yerel rezervasyon atomik
  yazılıp diske senkronize edilir; sonra zorunlu `persistAccountLedger(next)`
  kanonik hesap sayacını kalıcı olarak kaydetmelidir. Bu işlem başarısızsa
  DateRange çağrısı yapılmaz. Modül kendisi Git push yapmaz.
- `state/antalya-probe-2026-10-16.attempt.json` özel oluşturma ile kilitlenip
  diske senkronize edilir; reddedilen/başarısız/belirsiz denemede bile silinmez.
  Aynı kalıcı çalışma klasöründe ikinci veya eşzamanlı deneme engellenir.
  Sayacı veya deneme kaydını sıfırlamayın; geçici/yeni kopyayla tekrar denemeyin.
- Sonuç yalnız `probe-results/antalya-2026-10-16/v1/prayer-times/antalya.json`
  dosyasına gider. `public/` takvimlerine dokunulmaz; 2027 kapsamı doğrulanmaz.

Gelecekte canlı çağrı öncesinde güncel kanonik ledger alınmalı, başka indiriciyle
eşzamanlılık önlenmeli ve mevcut tekrar yapmayan istemci ile kanonik kalıcılık
bağlantısı açıkça sağlanmalıdır. Bu hazırlık yeni erişim oluşturmaz, üretim
zamanlamasını değiştirmez veya canlı deneme yetkisi vermez. Farklı tarih aralığı
ayrı kapsam incelemesi gerektirir.

### Ayrı tarayıcı göreviyle en küçük doğrulama yolu

1. Hesap sahibi mevcut resmî tarayıcı oturumunu kullanır. Oturum yetkisiz/sona
   ermişse giriş ve Swagger yetkilendirmesini kendisi tamamlar; parola/token
   sohbete, dosyaya veya bu komutlara aktarılmaz. Giriş yanıtı/Authorize ekranı
   kapatılıp yalnız sır içermeyen kota yanıtı paylaşılır.
2. Güncel kanonik ledger ve eşzamanlı iş durumu kontrol edilir. Tarayıcıdan alınan
   taze Quota/My yanıtının **yalnız JSON gövdesi** çevrimdışı kontrol edilir:
   `node sync/antalya-browser-check.mjs quota < /path/to/quota-response.json`.
   Başarılı kontrol kota rezervasyonu oluşturmaz veya çağrı yapma izni yerine geçmez.
3. Kalıcı tek deneme kaydı ve aylık Antalya rezervasyonu kanonik depoda çağrıdan
   önce doğrulanır. Mevcut modül kullanılacaksa gerçek `persistAccountLedger`
   bağlantısı gerekir. Tarayıcıda ayrı yürütülen bir POST, bu modülün otomatik
   kilit/rezervasyon güvencesinden yararlanmaz; koordinatör bunları ayrıca
   kanıtlamadan tarayıcı isteği gönderemez. Bu dalda kanonik kayıt bağlantısı
   veya tarayıcı köprüsü oluşturulmamıştır.
4. Kota kontrolü hâlâ beş dakikalık pencere içindeyken **bir kez**
   `POST /api/PrayerTime/DateRange` gönderilir:
   `{"cityId":9225,"startDate":"2026-10-16T00:00:00","endDate":"2026-10-17T00:00:00"}`.
   Ana üretim workflow'u / `force_city=antalya` bu deneme için kullanılmaz.
   Gecikme, hata veya belirsizlikte durulur; yeni sorgu/istek otomatik tekrarlanmaz.
   Modül, rezervasyon sonrasında da aynı kota yanıtını DateRange'den hemen önce
   yeniden doğrular; yeni bir Quota/My isteği yapmaz.
5. Dönen yanıtın yalnız JSON gövdesi yerelde kontrol edilir:
   `node sync/antalya-browser-check.mjs calendar < /path/to/antalya-response.json`.
   Komut iki günlük kapsamı ve beş vaktin yapısını doğrular; ağa çıkmaz ve
   üretim takvimi/ledger yazmaz. Yanıt yalnız vakitlerden oluşuyorsa şehir
   kimliğini tek başına kanıtlayamaz (`requestIdentityVerified:false`); tarayıcı
   isteğinin `9225` gövdesiyle yapıldığı ayrıca kanıtlanmalıdır.

Bu komutlar gerçek test tamamlandı iddiası üretmez. Bu hazırlık aşamasında
canlı çağrı yapılmadı; yalnız sentetik girdilerle çevrimdışı test edildi.

### Üretimde geçici yalnız Antalya geçişi

`sync/github-runner.mjs` bütün 81 eşleştirmeyi doğruladıktan sonra yalnız
`antalya / 9225 / 507` kaydını işleme geçirir. Zamanlanmış işte seçim boş olabilir;
elle çalıştırmada yalnız boş seçim veya `antalya` kabul edilir. Diğer şehir,
wildcard, çoklu ya da değişmiş eşleştirme hesap isteğinden önce reddedilir.
Kısıtı genişleten ortam değişkeni veya `FORCE_CITY` istisnası yoktur.

Çağrı öncesinde `state/antalya-rollout-attempt.json` özel oluşturma ile yazılıp
diske senkronize edilir. Güncellenmiş `state/ledger.json` ve deneme kaydı aynı
Git commitinde kanonik `main` dalına kaydedilip push tamamlanmadan DateRange
yapılmaz. En fazla bir Antalya DateRange denemesi vardır; hatada/belirsizlikte
rezervasyon geri alınmaz. Kayıt zaten varsa, içeriği bozuk olsa bile, sonraki iş
auth/API çağrısı yapmadan `already_reserved` sonucu verir. Bu kayıt ve sayaç
silinmemeli/sıfırlanmamalıdır. Başarısız push çağrıyı engeller; üretim workflow'unun
mevcut ortak concurrency grubu ve kanonik push çakışma koruması korunur.

Başarılı yanıt yalnız Antalya'nın üretim dosyasını güncelleyebilir; diğer 80 dosya
işleme alınmaz. Üretim isteği mevcut `allowedWindow()` aralığını kullanır:
16 Ekim 2026 itibarıyla 16 Ekim 2026–31 Aralık 2027. Tam aralık doğrulanamazsa
eski Antalya dosyası korunur, deneme kaydı kalır; ikinci otomatik deneme yapılmaz.
İki günlük tarayıcı kontrolü bu geniş üretim aralığını kanıtlamaz.

Bu kısıtın kaldırılması ve 81 şehre yayılma ayrı kod değişikliği/inceleme
gerektirir. Bu PR'de canlı auth, kanonik rezervasyon push'u, üretim DateRange
yanıtı ve 2027 kapsamı birlikte doğrulanmış değildir. Kodun eklenmesi bu
adımların çalıştırıldığı anlamına gelmez; birleştirme veya workflow başlatılmadı.

Veriler Diyanet kaynaklıdır; bu depo Diyanet adına yeniden lisans vermez. Dağıtım kapsamı ilgili kurumun kullanım koşullarına tabidir.
