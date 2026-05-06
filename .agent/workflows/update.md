---
description: Release workflow — bump version, update changelogs, commit, push, tag and publish to ClawHub
---

# /update — Plugin Release Workflow

Khi user gõ `/update`, thực hiện tuần tự các bước sau.

## Bước 1 — Xác định version mới

Hỏi user hoặc đọc từ context:
- Nếu user đã nói version mới (VD: "update lên 2.5.2"), dùng version đó.
- Nếu không, đọc version hiện tại từ `package.json` → hỏi user muốn bump lên patch/minor/major hay nhập version cụ thể.
- Tính version mới theo quy tắc semver.

## Bước 2 — Lấy thông tin thay đổi

Xác định các thay đổi hoặc hỏi user: "Những thay đổi chính trong bản này là gì?"
Nếu user không cung cấp, dùng placeholder chung chung về sửa lỗi và cải thiện.

## Bước 3 — Cập nhật CHANGELOG và README

Thêm entry mới vào đầu file `CHANGELOG.md` (Dưới header Changelog):

```markdown
## [{NEW_VERSION}] - {TODAY_DATE}

- {Chi tiết thay đổi 1}
- {Chi tiết thay đổi 2}
```

Kiểm tra xem `README.md` có cần cập nhật tính năng mới không, nếu có thì tự động sửa.

## Bước 4 — Cập nhật version trong code

// turbo
Cập nhật version trong `package.json` mà không tự động tạo git tag:
```powershell
npm version {NEW_VERSION} --no-git-tag-version
```

Và dùng tool thay thế text để đổi `version` trong `openclaw.plugin.json` thành bản mới.

## Bước 5 — Verify trước khi commit

// turbo
Chạy lệnh kiểm tra cú pháp và thử đóng gói:
```powershell
node --check index.js
npm pack --dry-run
```
Nếu pass → tiếp tục. Nếu fail → dừng lại, báo lỗi cho user.

## Bước 6 — Git commit

// turbo
```powershell
git add -A
git commit -m "chore: release v{NEW_VERSION}"
```

## Bước 7 — Git tag và Push

// turbo
```powershell
git push
git tag v{NEW_VERSION}
git push --tags
```

## Bước 8 — Publish lên ClawHub

// turbo
Publish plugin lên ClawHub:
```powershell
$commit = (git rev-parse HEAD); npx clawhub package publish . --source-repo "https://github.com/tuanminhhole/openclaw-facebook-crawler" --source-commit $commit --changelog "Docs: updated by AI"
```

## Bước 9 — Tổng kết

In ra tóm tắt:
```
✅ Release v{NEW_VERSION} hoàn thành!

Files đã cập nhật:
  - package.json & openclaw.plugin.json → v{NEW_VERSION}
  - CHANGELOG.md → prepended v{NEW_VERSION} entry

Git:
  - commit: "chore: release v{NEW_VERSION}"
  - tag: v{NEW_VERSION}
  - pushed to remote

ClawHub: Đã publish thành công!
```
