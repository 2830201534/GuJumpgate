# Releasing

这个文件用于记录把当前仓库正式发布到 GitHub 的最小流程。

## 发布前检查

1. 确认 `README.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md` 已更新
2. 检查代码、截图、默认配置里没有真实密钥、代理、手机号、邮箱、Cookie、回调地址
3. 确认 `docs/images` 中的 README 图片可以正常显示
4. 运行测试或至少完成关键功能自测
5. 检查 `git diff`，确认没有把本地临时文件一起带上

## 首次发布

1. 创建新的 GitHub 仓库
2. 设置默认分支为 `main`
3. 推送当前代码
4. 检查仓库首页 README、图片和许可证识别是否正常
5. 创建首个 Release，例如 `v0.1.0`

## 推送示例

```powershell
git status
git add .
git commit -m "Initial open source release"
git remote remove origin
git remote add origin https://github.com/<your-name>/<your-repo>.git
git branch -M main
git push -u origin main
```

## Release 说明建议

建议在 Release 页面说明：

- 这是首个公开开源版本
- 当前支持的运行环境
- 已知限制
- 需要用户自行配置的外部服务
