# Lattice

Lattice は、SNMP と Proxmox からネットワーク構成を収集し、3D ビューとツリーで確認できる動的トポロジー可視化ツールです。

## 起動前の準備

1. 設定ファイルを作成します。

```bash
cp config/lattice.example.yaml config/lattice.yaml
```

2. `config/lattice.yaml` を自分の環境に合わせて編集します。

- SNMP を使う場合は `community` と `seeds` を設定します。
- Proxmox を使う場合は `sources` に `kind: "proxmox"` の設定を追加し、`base_url` を設定します。
- `token_id` と `token_secret` は `${LATTICE_PROXMOX_TOKEN_ID}` のように環境変数で参照できます。

設定例:

```yaml
server:
  host: "127.0.0.1"
  port: 8080

discovery:
  max_hops: 10
  timeout_seconds: 5
  retries: 2
  concurrent_devices: 1

sources:
  - kind: "snmp"
    version: "2c"
    community: "public"
    seeds:
      - ip: "192.0.2.10"
        label: "vyos-core"

  - kind: "proxmox"
    base_url: "https://192.168.10.50:8006"
    token_id: "${LATTICE_PROXMOX_TOKEN_ID}"
    token_secret: "${LATTICE_PROXMOX_TOKEN_SECRET}"
    tls_verify: true
```

3. Proxmox を使う場合は起動前に環境変数を設定します。

```bash
export LATTICE_PROXMOX_TOKEN_ID='root@pam!lattice'
export LATTICE_PROXMOX_TOKEN_SECRET='replace-with-generated-secret'
```

自己署名証明書や IP 直指定で接続する環境では、`config/lattice.yaml` 側で `tls_verify: false` が必要な場合があります。

## 単発で探索する

探索結果を JSON で標準出力に出したい場合は、次を実行します。

```bash
cargo run -p lattice-server -- discover --config config/lattice.yaml
```

## Web UI を起動する

API とフロントエンドをまとめて起動する場合は、次を実行します。

```bash
cargo run -p lattice-server -- serve --config config/lattice.yaml
```

起動後はブラウザで `http://127.0.0.1:8080` を開きます。

ホストやポートを一時的に変えたい場合は、CLI オプションで上書きできます。

```bash
cargo run -p lattice-server -- serve --config config/lattice.yaml --host 0.0.0.0 --port 8080
```
