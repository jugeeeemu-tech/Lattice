# Lattice

Lattice は、SNMP と Proxmox からネットワーク構成を収集し、3D ビューとツリーで確認できる動的トポロジー可視化ツールです。

## 設定する

1. 設定ファイルを作成します。

```bash
cp config/lattice.example.yaml config/lattice.yaml
cp config/lattice.example.env config/lattice.env
```

2. `config/lattice.yaml` を自分の環境に合わせて編集します。

- `config/lattice.yaml` には接続先や探索設定を書きます。
- `config/lattice.env` にはトークンやコミュニティ文字列などの秘密情報を書きます。
- `config/lattice.env` は起動時に自動で読み込まれます。
- `lattice` コマンドは、通常は `config/lattice.yaml` を自動で見つけて読み込みます。

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
    community: "${LATTICE_SNMP_COMMUNITY}"
    seeds:
      - ip: "192.0.2.10"
        label: "vyos-core"

  - kind: "proxmox"
    base_url: "https://192.168.10.50:8006"
    token_id: "${LATTICE_PROXMOX_TOKEN_ID}"
    token_secret: "${LATTICE_PROXMOX_TOKEN_SECRET}"
    tls_verify: true
```

`config/lattice.env` の例:

```dotenv
LATTICE_SNMP_COMMUNITY=public
LATTICE_PROXMOX_TOKEN_ID=root@pam!lattice
LATTICE_PROXMOX_TOKEN_SECRET=replace-with-generated-secret
```

自己署名証明書や IP 直指定で接続する環境では、`config/lattice.yaml` 側で `tls_verify: false` が必要な場合があります。

## 探索結果を確認する

探索結果を JSON で標準出力に出したい場合は、次を実行します。

```bash
lattice discover
```

## Web 画面を開く

API とフロントエンドをまとめて起動する場合は、次を実行します。

```bash
lattice serve
```

起動後はブラウザで `http://127.0.0.1:8080` を開きます。

ホストやポートを一時的に変えたい場合は、CLI オプションで上書きできます。

```bash
lattice serve --host 0.0.0.0 --port 8080
```

標準の場所とは別の設定ファイルを使いたい場合だけ、`--config` を使います。

```bash
lattice serve --config /path/to/lattice.yaml
```
