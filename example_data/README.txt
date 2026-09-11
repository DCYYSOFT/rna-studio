示例序列说明
============

把 .fa 文件里 > 开头行之外的序列整段复制粘贴到左侧「序列」框即可，
程序会自动忽略 FASTA 头、并把 T 转成 U。

tRNA-Phe-yeast.fa
    酵母 tRNA-Phe，76 nt。折叠后是标准的三叶草结构，
    适合验证 naview 布局、编号、以及对比两个引擎的预测差异。

short-hairpin.fa
    21 nt 的简单发夹。适合试手动编辑：在图上右键拆掉一个茎区配对，
    看上方 ΔG 读数条怎么变。

cofold-duplex-demo.fa
    共折叠示例。切到「共折叠」模式后，
    链 A 填 GGGAAACCC，链 B 也填 GGGAAACCC，
    应得到 6 个链间配对的短双链（ΔG ≈ -7.1 kcal/mol，两个引擎一致）。
