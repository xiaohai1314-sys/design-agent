"""Read-only geometry checks. No layout generation, standards, file edits or network."""
import argparse
import json
import math
import time
from collections import deque
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw


def points(value):
    if not isinstance(value, list) or len(value) < 3:
        raise ValueError('A polygon needs at least three [x,y] vertices')
    result = []
    for p in value:
        if not isinstance(p, list) or len(p) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p):
            raise ValueError('Polygon coordinates must be finite numbers')
        result.append(tuple(float(v) for v in p))
    if result[0] == result[-1]:
        result.pop()
    if len(set(result)) < 3:
        raise ValueError('Degenerate polygon')
    area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(result,result[1:]+result[:1]))
    if abs(area)<1e-9:
        raise ValueError('Polygon area must be nonzero')
    def cross(a,b,c):return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    def on(a,b,c):return abs(cross(a,b,c))<1e-9 and min(a[0],b[0])-1e-9<=c[0]<=max(a[0],b[0])+1e-9 and min(a[1],b[1])-1e-9<=c[1]<=max(a[1],b[1])+1e-9
    segments=list(zip(result,result[1:]+result[:1]))
    for i,(a,b) in enumerate(segments):
        for j,(c,d) in enumerate(segments):
            if j<=i+1 or (i==0 and j==len(segments)-1):continue
            if (cross(a,b,c)*cross(a,b,d)<0 and cross(c,d,a)*cross(c,d,b)<0) or on(a,b,c) or on(a,b,d) or on(c,d,a) or on(c,d,b):
                raise ValueError('Polygons must be simple, without crossing or touching nonadjacent edges')
    return result


def shape(value):
    if ('rect' in value) == ('polygon' in value):
        raise ValueError('Choose exactly one rect or polygon')
    if 'polygon' in value:
        return points(value['polygon'])
    r = value['rect']
    if not isinstance(r, list) or len(r) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in r):
        raise ValueError('rect is [x0,y0,x1,y1], not x,y,width,height')
    x0, y0, x1, y1 = map(float, r)
    if x1 <= x0 or y1 <= y0:
        raise ValueError('rect needs x1>x0 and y1>y0')
    return [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]


def check(spec):
    started = time.perf_counter()
    boundary = points(spec['boundary'])
    objects = spec.get('objects', [])
    ids = [o['id'] for o in objects]
    if len(set(ids)) != len(ids) or not all(isinstance(i,str) and i for i in ids):
        raise ValueError('Object IDs must be nonempty and unique')
    objects = {o['id']: shape(o) for o in objects}
    routes, zones = spec.get('routes', []), spec.get('use_zones', [])
    if not routes and not zones:
        raise ValueError('Provide routes or use_zones to check')
    if len(routes) > 16 or len(zones) > 32:
        raise ValueError('Check critical local routes and representative use zones, not a whole building at once')
    widths = []
    for route in routes:
        w = route['width']
        if not isinstance(w,(int,float)) or not math.isfinite(w) or w <= 0:
            raise ValueError('Every route needs a positive declared width in the same coordinate units')
        for key in ['from','to']:
            p = route[key]
            if not isinstance(p,list) or len(p)!=2 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in p):
                raise ValueError('Route endpoints must be finite [x,y] points')
        widths.append(float(w))
    min_x, max_x = min(p[0] for p in boundary), max(p[0] for p in boundary)
    min_y, max_y = min(p[1] for p in boundary), max(p[1] for p in boundary)
    span = max(max_x-min_x,max_y-min_y)
    if span <= 0:
        raise ValueError('Boundary must have an area')
    resolution = float(spec.get('resolution', min(span/700, min(widths)/35) if widths else span/700))
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError('resolution must be positive')
    size = (math.ceil((max_x-min_x)/resolution)+5,math.ceil((max_y-min_y)/resolution)+5)
    if size[0]*size[1] > 1_200_000:
        raise ValueError('Local region too large at this resolution; crop the check to the relevant route or specify a coarser resolution')
    def xy(p):
        return ((p[0]-min_x)/resolution+2,(p[1]-min_y)/resolution+2)
    edge = [xy(p) for p in boundary]
    geom = {name:[xy(p) for p in polygon] for name,polygon in objects.items()}
    def inside(point,poly):
        x,y=point;hit=False
        for a,b in zip(poly,poly[1:]+poly[:1]):
            cross=(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0])
            if abs(cross)<1e-8 and min(a[0],b[0])-1e-8<=x<=max(a[0],b[0])+1e-8 and min(a[1],b[1])-1e-8<=y<=max(a[1],b[1])+1e-8:return True
            if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:hit=not hit
        return hit
    def paint_expanded(draw, poly, radius):
        draw.polygon(poly,fill=0)
        if radius>0:
            draw.line(poly+[poly[0]],fill=0,width=max(1,math.ceil(radius*2)),joint='curve')
            for x,y in poly:
                draw.ellipse((x-radius,y-radius,x+radius,y+radius),fill=0)
    mask_cache = {}
    def free_mask(width=0,ignore=()):
        key=(float(width),tuple(sorted(ignore)))
        if key in mask_cache:
            return mask_cache[key]
        mask = Image.new('L',size,0)
        draw=ImageDraw.Draw(mask)
        draw.polygon(edge,fill=255)
        radius=width/(2*resolution)
        if radius>0:
            draw.line(edge+[edge[0]],fill=0,width=max(1,math.ceil(radius*2)),joint='curve')
            for x,y in edge:
                draw.ellipse((x-radius,y-radius,x+radius,y+radius),fill=0)
        for name,poly in geom.items():
            if name not in ignore:
                paint_expanded(draw,poly,radius)
        mask_cache[key]=mask
        return mask
    def connected(mask, a, b):
        width,height=size
        a,b=[tuple(int(round(v)) for v in xy(p)) for p in (a,b)]
        data=mask.tobytes()
        valid=lambda p:0<=p[0]<width and 0<=p[1]<height and data[p[1]*width+p[0]]>0
        blocked=[name for name,p in [('from',a),('to',b)] if not valid(p)]
        if blocked:
            return False,blocked
        first=a[1]*width+a[0];goal=b[1]*width+b[0]
        visited=bytearray(width*height);visited[first]=1;q=deque([first])
        while q:
            at=q.popleft()
            if at==goal:
                return True,[]
            x,y=at%width,at//width
            neighbors=[]
            if x:neighbors.append(at-1)
            if x+1<width:neighbors.append(at+1)
            if y:neighbors.append(at-width)
            if y+1<height:neighbors.append(at+width)
            for n in neighbors:
                if not visited[n] and data[n]:
                    visited[n]=1;q.append(n)
        return False,[]
    # Both sides of the corridor and the sampled endpoints contribute raster error.
    width_tolerance = 4 * resolution
    result_routes = []
    for route in routes:
        width = float(route['width'])
        start, end = route['from'], route['to']
        clear_with_margin, _ = connected(free_mask(width + width_tolerance), start, end)
        if clear_with_margin:
            status, blocked_endpoints = 'clear', []
        else:
            passes, blocked_endpoints = connected(free_mask(width), start, end)
            if not passes:
                relaxed_width = max(0.0, width - width_tolerance)
                passes, _ = connected(free_mask(relaxed_width), start, end)
            status = 'borderline' if passes else 'blocked'
        result_routes.append({
            'id': route.get('id', 'route'),
            'declaredWidth': width,
            'status': status,
            'widthTolerance': width_tolerance,
            'blockedEndpoints': blocked_endpoints,
        })
    result_zones=[]
    for z in zones:
        ignore=z.get('ignore_objects',[])
        if not set(ignore)<=set(objects):
            raise ValueError('use_zones ignore_objects must reference actual object IDs')
        raw_poly=shape(z)
        outside_vertices=any(not inside(p,boundary) for p in raw_poly)
        poly=[xy(p) for p in raw_poly]
        zone=Image.new('L',size,0);d=ImageDraw.Draw(zone);d.polygon(poly,fill=255)
        failed=ImageChops.subtract(zone,free_mask(0,ignore))
        hits=[]
        for name,obj in geom.items():
            if name in ignore:continue
            ob=Image.new('L',size,0);ImageDraw.Draw(ob).polygon(obj,fill=255)
            if ImageChops.multiply(zone,ob).getbbox():hits.append(name)
        only_boundary=Image.new('L',size,0);ImageDraw.Draw(only_boundary).polygon(edge,fill=255)
        outside=outside_vertices or bool(ImageChops.subtract(zone,only_boundary).getbbox())
        inner=zone.copy();idraw=ImageDraw.Draw(inner);idraw.line(poly+[poly[0]],fill=0,width=3,joint='curve')
        deep=bool(ImageChops.multiply(failed,inner).getbbox())
        result_zones.append({'id':z.get('id','use-zone'),'status':'blocked' if outside_vertices or deep else 'borderline' if failed.getbbox() else 'clear','intersectedObjects':hits,'outsideBoundary':outside})
    return {'ok':True,'units':spec.get('units','same as supplied geometry'),'resolution':resolution,'approximateTolerance':resolution*2,'gridCells':size[0]*size[1],'routes':result_routes,'useZones':result_zones,'elapsedMs':round((time.perf_counter()-started)*1000,2),'scope':'Only supplied geometry and declared use state were checked; not source interpretation, code compliance or full design acceptance. No design was modified.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec',type=Path)
    args=parser.parse_args()
    try:
        result=check(json.loads(args.spec.read_text(encoding='utf-8-sig')))
    except (ValueError,KeyError,TypeError,OSError) as e:
        print(json.dumps({'ok':False,'error':str(e),'noDesignModified':True},ensure_ascii=False))
        return 2
    print(json.dumps(result,ensure_ascii=False))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
