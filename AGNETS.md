用户的验收开发流程
在docs每个loop表示一次开发验收循环，每次我们都用最新的loop来操作 
文件结构 loop-demo 
*.decision.md: 决定
*.plan.md: 根据决定制定的一轮计划
*.record.md: 原始的记录用户的记录的问题，或者是问题
*.output.md: 遗留的问题终结这个loop
1. 用添加问题到record.md 中 git commit 
2. Agent 回复逐条处理记录 （答复/调查/编写执行计划）但是严禁修改代码 可以写文档到*.decision.md 下 每处理一个一个commit
3. 用户在处理完一部分的记录后 创建*.plan.md 写出我们如何执行多个decison 的执行 添加commit 
4. 用户要求执行按照*.plan.md执行计划 添加commit
5. 然后我们可以把遗留的问题或者日后规划处理的点放在*.output.md中 添加commit

对于*.decision.md 用户也可以自己记录decision