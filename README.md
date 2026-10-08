# Türkiye il merkezleri — resmî namaz vakitleri

81 il merkezi için Diyanet İşleri Başkanlığı Awqat Salah servisinden alınan, doğrulanmış takvimlerin açık veri kopyasıdır. Resmî bir Diyanet uygulaması/deposu değildir. İlçeleri kapsamaz.

Veri kaynağı: https://awqatsalah.diyanet.gov.tr/
Resmî takvim: https://namazvakitleri.diyanet.gov.tr/

## Kullanım

`public/v1/prayer-times/{cityId}.json` — İstanbul saat diliminde Sabah (imsak), Öğle, İkindi, Akşam, Yatsı. İl anahtarları ve resmî merkez eşleştirmeleri `config/cities.json` dosyasındadır.

Ham dosya kökü: `https://raw.githubusercontent.com/MustafaGokbasi/vaktinde-prayer-data/main/public`
Her dosyada kaynak, son alınma zamanı ve kapsanan tarih aralığı bulunur. Önbellekte saklayın; günde birden sık indirmeyin. GitHub erişilebilirlik garantisi vermez. Eksik tarihler için resmî veri varmış gibi hesaplanmış saat üretmeyin.

## Güncelleme

GitHub Actions her gün yaklaşık 06:23 Türkiye saatinde kontrol eder; yedi günden eski veya kapsamı yetersiz dosyaları yeniler. GitHub zamanlanmış işleri geciktirebilir. Ekimden itibaren gelecek yılın sonuna kadar takvim istenir. Kota ve veri yapısı değişirse sistem durur ve son doğrulanmış dosyalar korunur.

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

Veriler Diyanet kaynaklıdır; bu depo Diyanet adına yeniden lisans vermez. Dağıtım kapsamı ilgili kurumun kullanım koşullarına tabidir.
