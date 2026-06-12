const THOUGHT_PAGE_SIZE = 15;

const THOUGHT_MODULE_PAGES = [
  {
    module: 'workout',
    basePath: 'thoughts/',
    source: 'thoughts/index.md',
    title: '锻炼随想',
  },
  {
    module: 'misc',
    basePath: 'misc/',
    source: 'misc/index.md',
    title: '杂七杂八',
  },
  {
    module: 'body_feedback',
    basePath: 'body-feedback/',
    source: 'body-feedback/index.md',
    title: '身体反馈',
  },
];

function resolveThoughtModule(post) {
  if (post?.thought_module) {
    return post.thought_module;
  }
  if (post?.tags?.findOne && post.tags.findOne({ name: '身体反馈' })) {
    return 'body_feedback';
  }
  if (post?.tags?.findOne && post.tags.findOne({ name: '杂七杂八' })) {
    return 'misc';
  }
  return 'workout';
}

function isThoughtPost(post) {
  return post?.tags?.findOne && post.tags.findOne({ name: '随想' });
}

hexo.extend.generator.register('thoughts_pagination', function (locals) {
  const generatedPages = [];

  for (const modulePage of THOUGHT_MODULE_PAGES) {
    const thoughts = locals.posts
      .sort('date', 'desc')
      .filter(isThoughtPost)
      .filter((post) => resolveThoughtModule(post) === modulePage.module);
    const totalPages = Math.ceil(thoughts.length / THOUGHT_PAGE_SIZE);

    for (let currentPage = 2; currentPage <= totalPages; currentPage += 1) {
      generatedPages.push({
        path: `${modulePage.basePath}page/${currentPage}/index.html`,
        layout: 'thoughts',
        data: {
          title: modulePage.title,
          source: modulePage.source,
          path: modulePage.basePath,
          thought_module: modulePage.module,
          thought_base_path: modulePage.basePath,
          thought_page_current: currentPage,
          thought_page_size: THOUGHT_PAGE_SIZE,
        },
      });
    }
  }

  return generatedPages;
});
