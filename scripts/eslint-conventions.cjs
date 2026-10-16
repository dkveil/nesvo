const kebabCase = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/;
const routeName =
  /^(?:_layout|\+not-found|\[(?:\.\.\.)?[a-z][a-z0-9-]*\]|\[\[\.\.\.[a-z][a-z0-9-]*\]\])(?:\.[a-z0-9]+)*$/;

module.exports = {
  rules: {
    'kebab-case': {
      meta: {
        type: 'suggestion',
        schema: [],
        messages: { invalid: 'Use kebab-case for source files and folders: {{name}}.' },
      },
      create(context) {
        return {
          Program(node) {
            const filename = context.getPhysicalFilename().replaceAll('\\', '/');
            const relative = filename.split('/apps/mobile/src/')[1];
            if (!relative) return;
            const segments = relative.split('/');
            for (const name of segments) {
              if (name === '__tests__' || kebabCase.test(name)) continue;
              if (segments[0] === 'app' && routeName.test(name)) continue;
              context.report({ node, messageId: 'invalid', data: { name } });
            }
          },
        };
      },
    },
  },
};
