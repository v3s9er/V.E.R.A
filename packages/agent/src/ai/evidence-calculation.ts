/** Fixed AST interpreter. Submitted text is never passed to eval/exec/compile. */
export const PYTHON_VALUE_CHECKER = String.raw`
import ast,json,sys
MAX=4096
trace=[]
values={}
steps=0
def bound(v):
 if type(v) is int and v.bit_length()<=256: return v
 if type(v) is str and len(v)<=MAX: return v
 if type(v) in (bool,type(None)): return v
 raise ValueError('value_limit_or_type')
def name(s):
 if not s.isidentifier() or s.startswith('_') or len(s)>64: raise ValueError('invalid_name')
 return s
def binary(op,a,b):
 if isinstance(op,ast.Add): return bound(a+b)
 if isinstance(op,ast.Sub) and type(a) is int and type(b) is int: return bound(a-b)
 if isinstance(op,ast.Mult):
  if type(a) is str and type(b) is int and len(a)*max(0,b)<=MAX: return a*b
  if type(b) is str and type(a) is int and len(b)*max(0,a)<=MAX: return b*a
  if type(a) is int and type(b) is int: return bound(a*b)
  raise ValueError('multiplication_limit')
 if type(a) is int and type(b) is int:
  if isinstance(op,ast.FloorDiv): return bound(a//b)
  if isinstance(op,ast.Mod): return bound(a%b)
  if isinstance(op,ast.BitXor): return bound(a^b)
  if isinstance(op,ast.BitOr): return bound(a|b)
  if isinstance(op,ast.BitAnd): return bound(a&b)
  if isinstance(op,(ast.LShift,ast.RShift)) and 0<=b<=256: return bound(a<<b if isinstance(op,ast.LShift) else a>>b)
 raise ValueError('unsupported_operator')
def read(n):
 global steps
 steps+=1
 if steps>1000: raise ValueError('step_limit')
 if isinstance(n,ast.Constant): return bound(n.value)
 if isinstance(n,ast.Name): return values[name(n.id)]
 if isinstance(n,ast.BinOp): return binary(n.op,read(n.left),read(n.right))
 if isinstance(n,ast.UnaryOp):
  v=read(n.operand)
  if type(v) is int:
   if isinstance(n.op,ast.USub): return bound(-v)
   if isinstance(n.op,ast.UAdd): return v
   if isinstance(n.op,ast.Invert): return bound(~v)
  raise ValueError('unsupported_unary')
 if isinstance(n,ast.Subscript):
  v=read(n.value)
  if type(v) is not str: raise ValueError('string_only')
  if isinstance(n.slice,ast.Slice):
   parts=[read(x) if x is not None else None for x in (n.slice.lower,n.slice.upper,n.slice.step)]
   if any(x is not None and (type(x) is not int or abs(x)>MAX) for x in parts): raise ValueError('slice_limit')
   return bound(v[slice(*parts)])
  i=read(n.slice)
  if type(i) is not int or abs(i)>MAX: raise ValueError('index_limit')
  return bound(v[i])
 if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and not n.keywords and len(n.args)==1:
  fn=n.func.id; v=read(n.args[0])
  if fn in values: raise ValueError('shadowed_function')
  if fn=='chr' and type(v) is int: return bound(chr(v))
  if fn=='ord' and type(v) is str: return bound(ord(v))
  if fn=='len' and type(v) is str: return len(v)
  if fn=='str' and type(v) in (str,int,bool): return bound(str(v))
 raise ValueError('unsupported_expression')
try:
 source=sys.stdin.buffer.read(8193)
 if not source or len(source)>8192: raise ValueError('source_limit')
 tree=ast.parse(source.decode('utf-8-sig'))
 if sum(1 for _ in ast.walk(tree))>512 or len(tree.body)>128: raise ValueError('ast_limit')
 for stmt in tree.body:
  if isinstance(stmt,ast.Assign) and len(stmt.targets)==1 and isinstance(stmt.targets[0],ast.Name):
   key=name(stmt.targets[0].id); values[key]=read(stmt.value); entry={'name':key,'value':values[key]}
  elif isinstance(stmt,ast.AugAssign) and isinstance(stmt.target,ast.Name):
   key=name(stmt.target.id); values[key]=binary(stmt.op,values[key],read(stmt.value)); entry={'name':key,'value':values[key]}
  elif isinstance(stmt,ast.Expr): entry={'value':read(stmt.value)}
  else: raise ValueError('unsupported_statement')
  trace.append({'line':stmt.lineno,**entry})
  if len(json.dumps(trace,ensure_ascii=True))+len(json.dumps(values,ensure_ascii=True))>24000: raise ValueError('result_limit')
 print(json.dumps({'available':True,'verified':True,'method':'bounded-ast-values','originalExecuted':False,'values':values,'trace':trace}))
except Exception as e:
 codes={'value_limit_or_type','invalid_name','multiplication_limit','unsupported_operator','step_limit','unsupported_unary','string_only','slice_limit','index_limit','shadowed_function','unsupported_expression','source_limit','ast_limit','unsupported_statement','result_limit'}
 code=str(e) if type(e) is ValueError and str(e) in codes else type(e).__name__
 print(json.dumps({'available':True,'verified':False,'method':'bounded-ast-values','originalExecuted':False,'reason':code}))
`;
