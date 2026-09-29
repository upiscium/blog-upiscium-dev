---
slug: first-log
lang: ja
title: System Design Notes for Frontend
description: UI分割、状態管理、配信最適化をどう設計するかをまとめた記事。
publishedAt: 2026-04-08
updatedAt: 2026-04-10
tags:
  - architecture
  - frontend
  - performance
---

# はじめに

この記事では、フロントエンドの設計をどう考えるかを整理します。

## チェックリスト

- [x] UIを分割する
- [x] 状態を整理する
- [ ] 配信最適化を検討する

## コード

```ts
type Post = {
  title: string;
  tags: string[];
};

const post: Post = {
  title: 'System Design Notes for Frontend',
  tags: ['architecture', 'frontend'],
};
```

## テーブル

| 項目 | 内容 |
| --- | --- |
| UI | コンポーネント分割 |
| State | 小さく保つ |
| Perf | 体感速度を優先 |

## 引用

> まずは読める構造にする。その後で最適化する。
