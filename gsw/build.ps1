# build.ps1 — embute os prints em base64 e gera o gsw.html autocontido.
# A saida vai direto pra src/assets/, que e de onde o servidor HTTP do bot
# serve o /gsw (ver src/health.js) e o que entra na imagem Docker.
# Uso:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$imgDir = Join-Path $root 'img'
$assets = Join-Path (Split-Path -Parent $root) 'src\assets'

# chave usada no HTML  ->  arquivo em img\
$map = [ordered]@{
  saida     = 'a01.png'   # 2021 - saida da GsW
  bigo1     = 'a02.png'   # 2021 - DM com o Bigo (1)
  bigo2     = 'a03.png'   # 2021 - DM com o Bigo (2)
  bigo3     = 'a04.png'   # 2021 - DM com o Bigo (3)
  primeiro  = 'g01.png'   # 12/07/2024 - 1a mensagem do Discord da WyBR
  motivo1   = 'g02.png'   # Volkzz explicando o motivo (1)
  motivo2   = 'g03.png'   # Volkzz explicando o motivo (2)
  oferta    = 'i01.png'   # 11/01/2025 - oferta de fusao do iMonoYasuo
  fusao1    = '09.png'    # 2025 - fusao / Volkzz101 (1)
  fusao2    = '10.png'    # 2025 - fusao / Volkzz101 (2)
  fusao3    = '11.png'    # 2025 - fusao / Volkzz101 (3)
  fusao4    = '12.png'    # 2025 - fusao / Volkzz101 (4)
  convite   = '13.png'    # 2025 - convite do radicchi
  ban       = '14.png'    # 2025 - ban do Dyno
  poach     = 'b01.png'   # 2025 - recrutamento no #conversas da WnBR
  difamacao = '15.png'    # 24/04/2025 - acusacao de difamacao
  blacklist1= 'f01.png'   # 24/04/2025 - ban em massa (1)
  blacklist2= 'f02.png'   # 24/04/2025 - ban em massa (2)
  shout     = 'c01.png'   # 2026 - shout por cima
  facista1  = 'j01.png'   # 2026 - shout "fascist dictators" (1)
  facista2  = 'j02.png'   # 2026 - "i shouted for a friend" (2)
  facista3  = 'j03.png'   # 2026 - outros players comentando (3)
  grief1    = 'l01.png'   # 28/07/2026 - griefing no #guild_recruitment oficial
  grief2    = 'l02.png'   # 28/07/2026 - print de Google que eles postaram (1)
  grief3    = 'l03.png'   # 28/07/2026 - print de Google que eles postaram (2)
  call      = 'c02.png'   # 2026 - lista de quem estava na call
  conf1     = 'd01.png'   # 2026 - 67sugestivo67 (1)
  conf2     = 'd02.png'
  conf3     = 'd03.png'
  conf4     = 'd04.png'
  conf5     = 'd05.png'
  conf6     = 'd06.png'
  conf7     = 'd07.png'
  banwynn   = 'h01.png'   # 2026 - tela de ban do Wynncraft (motivo: blackmail)
  sugestivoban = 'k01.png' # 2026 - Yasuo avisando do ban do 67sugestivo67
  paz1      = 'e01.png'   # 2026 - neutralidade com o iMonoYasuo
  paz2      = '08.png'    # 2026 - ultima oferta de paz
}

function Get-Mime([byte[]]$b) {
  if ($b.Length -ge 8 -and $b[0] -eq 0x89 -and $b[1] -eq 0x50) { return 'image/png' }
  if ($b.Length -ge 12 -and $b[0] -eq 0x52 -and $b[1] -eq 0x49 -and $b[8] -eq 0x57) { return 'image/webp' }
  if ($b.Length -ge 3 -and $b[0] -eq 0xFF -and $b[1] -eq 0xD8) { return 'image/jpeg' }
  if ($b.Length -ge 4 -and $b[0] -eq 0x47 -and $b[1] -eq 0x49) { return 'image/gif' }
  return 'image/png'
}

$parts = New-Object System.Collections.ArrayList
$total = 0
foreach ($k in $map.Keys) {
  $f = Join-Path $imgDir $map[$k]
  if (-not (Test-Path $f)) {
    Write-Warning "FALTANDO: $k  ->  $($map[$k])   (o HTML vai mostrar 'PRINT INDISPONIVEL')"
    continue
  }
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $mime  = Get-Mime $bytes
  $b64   = [System.Convert]::ToBase64String($bytes)
  [void]$parts.Add("$k`:`"data:$mime;base64,$b64`"")
  $total += $bytes.Length
  Write-Host ("  {0,-10} {1,-9} {2,8:N0} B  {3}" -f $k, $map[$k], $bytes.Length, $mime)
}

$js = '{' + ($parts -join ',') + '}'

$tpl = Get-Content (Join-Path $root 'template.html') -Raw -Encoding UTF8
if ($tpl -notmatch '__IMG_DATA__') { throw 'template.html nao contem o marcador __IMG_DATA__' }
$out = $tpl.Replace('__IMG_DATA__', $js)

if (-not (Test-Path $assets)) { throw "src\assets nao encontrado em: $assets" }
$dest = Join-Path $assets 'gsw.html'
[System.IO.File]::WriteAllText($dest, $out, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host ("prints embutidos : {0}/{1}" -f $parts.Count, $map.Count)
Write-Host ("imagens          : {0:N0} KB" -f ($total/1KB))
Write-Host ("gsw.html         : {0:N0} KB" -f ((Get-Item $dest).Length/1KB))
Write-Host ("caminho          : {0}" -f $dest)
Write-Host ''
Write-Host 'Sobe o bot e abre em ${PUBLIC_URL}/gsw'
