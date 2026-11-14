"""仅供验收的原生 X11 窗口，用于确认截图包含浏览器外的二维码。"""
import ctypes as c


class NativeQrWindow:
    def __init__(self, matrix, title='CredMemo External QR'):
        self.x = x = c.CDLL('libX11.so.6')
        signatures = {
            'XOpenDisplay': (c.c_void_p, [c.c_char_p]),
            'XDefaultRootWindow': (c.c_ulong, [c.c_void_p]),
            'XInternAtom': (c.c_ulong, [c.c_void_p, c.c_char_p, c.c_int]),
            'XCreateSimpleWindow': (c.c_ulong, [c.c_void_p,c.c_ulong,c.c_int,c.c_int,c.c_uint,c.c_uint,c.c_uint,c.c_ulong,c.c_ulong]),
            'XStoreName': (c.c_int, [c.c_void_p,c.c_ulong,c.c_char_p]),
            'XMapRaised': (c.c_int, [c.c_void_p,c.c_ulong]),
            'XCreateGC': (c.c_void_p, [c.c_void_p,c.c_ulong,c.c_ulong,c.c_void_p]),
            'XSetForeground': (c.c_int, [c.c_void_p,c.c_void_p,c.c_ulong]),
            'XFillRectangle': (c.c_int, [c.c_void_p,c.c_ulong,c.c_void_p,c.c_int,c.c_int,c.c_uint,c.c_uint]),
            'XDrawString': (c.c_int, [c.c_void_p,c.c_ulong,c.c_void_p,c.c_int,c.c_int,c.c_char_p,c.c_int]),
            'XFlush': (c.c_int, [c.c_void_p]),
            'XChangeProperty': (c.c_int, [c.c_void_p,c.c_ulong,c.c_ulong,c.c_ulong,c.c_int,c.c_int,c.c_void_p,c.c_int]),
            'XDestroyWindow': (c.c_int, [c.c_void_p,c.c_ulong]),
            'XCloseDisplay': (c.c_int, [c.c_void_p]),
        }
        for name, (result, args) in signatures.items():
            getattr(x,name).restype = result
            getattr(x,name).argtypes = args
        self.display = display = x.XOpenDisplay(None)
        if not display:
            raise RuntimeError('Desktop acceptance requires an X11 display; use xvfb-run.')
        root = x.XDefaultRootWindow(display)
        names = ['_NET_CURRENT_DESKTOP','_NET_NUMBER_OF_DESKTOPS','_NET_ACTIVE_WINDOW','_NET_CLIENT_LIST','_NET_CLIENT_LIST_STACKING','_NET_WM_STATE','_NET_WM_WINDOW_TYPE','_NET_WM_WINDOW_TYPE_NORMAL','_NET_WM_NAME','_NET_WM_PID','WM_STATE','WM_CLASS','_NET_FRAME_EXTENTS','_NET_SUPPORTING_WM_CHECK']
        atoms = {name:x.XInternAtom(display,name.encode(),0) for name in names}
        scale, quiet = 6, 4
        side = (matrix['size'] + quiet * 2) * scale
        self.window = window = x.XCreateSimpleWindow(display,root,1500,30,side+16,side+56,0,0xffffff,0xffffff)
        x.XStoreName(display,window,title.encode())
        clients = (c.c_ulong * 1)(window)
        x.XChangeProperty(display,root,atoms['_NET_CLIENT_LIST'],33,32,0,clients,1)
        normal = (c.c_ulong * 1)(atoms['_NET_WM_WINDOW_TYPE_NORMAL'])
        x.XChangeProperty(display,window,atoms['_NET_WM_WINDOW_TYPE'],4,32,0,normal,1)
        state = (c.c_ulong * 2)(1,0)
        x.XChangeProperty(display,window,atoms['WM_STATE'],atoms['WM_STATE'],32,0,state,2)
        x.XMapRaised(display,window)
        self.gc = gc = x.XCreateGC(display,window,0,None)
        x.XSetForeground(display,gc,0x153f2c)
        label = b'CredMemo native QR fixture'
        x.XDrawString(display,window,gc,8,22,label,len(label))
        x.XSetForeground(display,gc,0)
        for row in range(matrix['size']):
            for col in range(matrix['size']):
                if matrix['data'][row * matrix['size'] + col]:
                    x.XFillRectangle(display,window,gc,8+(col+quiet)*scale,40+(row+quiet)*scale,scale,scale)
        x.XFlush(display)
        self.bounds = {'x':1508,'y':70,'width':side,'height':side}

    def close(self):
        self.x.XDestroyWindow(self.display,self.window)
        self.x.XCloseDisplay(self.display)
