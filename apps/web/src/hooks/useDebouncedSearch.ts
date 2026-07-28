import { useCallback, useEffect, useRef, useState } from 'react';

/** 停手多久之后发请求。太短会把后端打爆，太长会让人以为搜索坏了。 */
const DEBOUNCE_MS = 300;

/**
 * 搜索框的共同行为：**输入即搜（300ms 防抖），回车立刻搜**。
 *
 * 之前几个页面各写各的：首页要按回车、执行记录也要按回车，
 * 而首页的 placeholder 里写了「（回车搜索）」、执行记录没写。
 * codex 的原话：「两处交互不一致」。
 *
 * 修的方向是统一成输入即搜，而不是到处补「回车搜索」的文案 ——
 * 图纸的搜索框上没有那半句，那是后加的。**要在文案里解释交互，
 * 通常说明交互本身不对。**
 */
export function useDebouncedSearch(search: (query: string) => void): {
  value: string;
  onChange: (next: string) => void;
  onEnter: () => void;
} {
  const [value, setValue] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上一次真正发出去的词。回车按两次不该打两次请求。 */
  const sent = useRef<string | null>(null);
  const latest = useRef(search);
  latest.current = search;

  const fire = useCallback((query: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (sent.current === query) return;
    sent.current = query;
    latest.current(query);
  }, []);

  const onChange = useCallback(
    (next: string) => {
      // 显示立刻跟手 —— 防抖的是请求，不是输入框
      setValue(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fire(next), DEBOUNCE_MS);
    },
    [fire],
  );

  const onEnter = useCallback(() => fire(value), [fire, value]);

  // 卸载后别再发：那时候没人接得住结果，setState 会警告
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { value, onChange, onEnter };
}
