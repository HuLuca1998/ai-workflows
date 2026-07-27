/**
 * Preview.js 配置。VSCode 装了 Preview.js 插件后，
 * 打开 src/components/*.tsx 会在右侧渲染下方 *.stories.tsx 里声明的用例。
 */
module.exports = {
  wrapper: {
    path: '__previewjs__/Wrapper.tsx',
    componentName: 'Wrapper',
  },
};
