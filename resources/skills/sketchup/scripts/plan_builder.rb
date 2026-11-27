# encoding: utf-8
# DesignAgentPlanBuilder —— 读取 plan.json（cad/scripts/plan_extract.py 的产出），在 SketchUp 中生成户型白模：
# 墙体（按门窗洞口拆分为墙段、窗台、过梁，不依赖实体布尔运算）、门扇 / 推拉门 / 窗玻璃、各房间地面与顶棚。
#
# 用法（通过 sketchup__eval_ruby 执行）：
#   load 'C:/.../skills/sketchup/scripts/plan_builder.rb'
#   DesignAgentPlanBuilder.build('C:/.../.design-agent/plans/xxx.plan.json', { style: 'modern_minimal' })
#   DesignAgentPlanBuilder.measure   # 读回已生成模型的尺寸，用于和 plan.json 核对
#
# 所有几何都放在名为 DesignAgentPlan_Root 的总组里；重复执行只替换上一次生成的总组，不动用户其他内容。

require 'json'

module DesignAgentPlanBuilder
  VERSION = '1.0.0'
  ROOT_NAME = 'DesignAgentPlan_Root'
  DICT = 'design_agent'
  WET_ROOM = /卫生间|卫浴|浴室|洗手间|厕所|厨房|阳台|露台|设备|bath|wc|toilet|kitchen|balcony/i

  PALETTE = {
    wall: [236, 234, 230],
    floor_dry: [198, 166, 128],
    floor_wet: [214, 212, 206],
    ceiling: [248, 248, 246],
    door: [150, 112, 78],
    frame: [60, 62, 66],
    glass: [188, 214, 226],
    column: [214, 210, 204]
  }.freeze

  def self.mm(v)
    v.to_f / 25.4
  end

  def self.pt(x_mm, y_mm, z_mm = 0)
    Geom::Point3d.new(mm(x_mm), mm(y_mm), mm(z_mm))
  end

  # ---------------------------------------------------------------- 材质

  def self.color_material(model, name, rgb, alpha = nil)
    mat = model.materials[name] || model.materials.add(name)
    mat.color = Sketchup::Color.new(*rgb)
    mat.alpha = alpha if alpha
    mat
  end

  # 有客厅预置包的材质库时沿用其风格贴图（现代极简 / 新中式 / 侘寂原木 / 轻奢），否则用纯色
  def self.build_materials(model, opts, warnings)
    mats = {
      wall: color_material(model, 'DA_Wall', PALETTE[:wall]),
      floor_dry: color_material(model, 'DA_Floor', PALETTE[:floor_dry]),
      floor_wet: color_material(model, 'DA_FloorTile', PALETTE[:floor_wet]),
      ceiling: color_material(model, 'DA_Ceiling', PALETTE[:ceiling]),
      door: color_material(model, 'DA_Door', PALETTE[:door]),
      frame: color_material(model, 'DA_Frame', PALETTE[:frame]),
      glass: color_material(model, 'DA_Glass', PALETTE[:glass], 0.32),
      column: color_material(model, 'DA_Column', PALETTE[:column])
    }
    preset_dir = opts[:preset_dir].to_s
    finish = File.join(preset_dir, 'scripts', 'finish.rb')
    return mats if preset_dir.empty? || !File.exist?(finish)

    begin
      load finish
      style = LivingRoomPreset::Finish.normalize_style(opts[:style] || 'modern_minimal')
      styled = LivingRoomPreset::Finish.build_materials(model, preset_dir, style, warnings)
      mats[:wall] = styled[:wall] if styled[:wall]
      mats[:floor_dry] = styled[:floor] if styled[:floor]
      mats[:floor_wet] = styled[:feature_stone] if styled[:feature_stone]
      mats[:ceiling] = styled[:ceiling] if styled[:ceiling]
      mats[:door] = styled[:grille_wood] if styled[:grille_wood]
      mats[:frame] = styled[:metal] if styled[:metal]
      mats[:glass] = styled[:glass] if styled[:glass]
    rescue => e
      warnings << "风格材质加载失败，改用纯色：#{e.message}"
    end
    mats
  end

  def self.paint(group, mat)
    return unless mat
    group.material = mat
    group.entities.grep(Sketchup::Face).each do |f|
      f.material = mat
      f.back_material = mat
    end
  end

  # ---------------------------------------------------------------- 几何

  # 沿墙方向的长方体：起点 origin，方向单位向量 d，法向 n，[u0,u1] 沿墙，[z0,z1] 高度，厚度 t（以中心线对称）
  def self.wall_box(ents, origin, d, n, u0, u1, z0, z1, t, mat, name)
    return nil if u1 - u0 < 1 || z1 - z0 < 1
    grp = ents.add_group
    grp.name = name
    half = t / 2.0
    corners = [[u0, -half], [u1, -half], [u1, half], [u0, half]].map do |u, v|
      pt(origin[0] + d[0] * u + n[0] * v, origin[1] + d[1] * u + n[1] * v, z0)
    end
    face = grp.entities.add_face(corners)
    if face
      face.reverse! if face.normal.z < 0
      face.pushpull(mm(z1 - z0))
    end
    paint(grp, mat)
    grp
  end

  # 墙体实心段：[u0, u1] 扣掉柱子占的区段（column_spans）后逐段建。柱位不出墙体，由柱子自己占位，
  # 否则墙和柱是两个重叠的实体，体积和布尔运算都会出问题
  def self.solid_box(ents, origin, d, n, u0, u1, z0, z1, t, mat, name, spans)
    pieces = [[u0, u1]]
    (spans || []).each do |a, b|
      a = a.to_f
      b = b.to_f
      pieces = pieces.flat_map do |p0, p1|
        next [[p0, p1]] if b <= p0 || a >= p1
        [[p0, [a, p1].min], [[b, p0].max, p1]].select { |x, y| y - x > 1 }
      end
    end
    pieces.each { |p0, p1| wall_box(ents, origin, d, n, p0, p1, z0, z1, t, mat, name) }
  end

  # 柱子：轴对齐矩形截面，从 z0 挤到 z1
  def self.column_box(ents, cx, cy, w, d, z0, z1, mat, name)
    return nil if w < 1 || d < 1 || z1 - z0 < 1
    grp = ents.add_group
    grp.name = name
    corners = [[-w / 2.0, -d / 2.0], [w / 2.0, -d / 2.0], [w / 2.0, d / 2.0], [-w / 2.0, d / 2.0]].map do |u, v|
      pt(cx + u, cy + v, z0)
    end
    face = grp.entities.add_face(corners)
    if face
      face.reverse! if face.normal.z < 0
      face.pushpull(mm(z1 - z0))
    end
    paint(grp, mat)
    grp
  end

  # holes：要从地面里挖掉的块（柱子凸出墙面的部分）。先画外轮廓，再在同一平面上画每个块并删掉块形成的面，
  # 块在轮廓内部时成洞，贴着轮廓边时成缺口。measure 读的是组里所有面的面积之和，等于扣柱后的净面积。
  def self.floor_face(ents, polygon, z, mat, name, up = true, holes = [])
    grp = ents.add_group
    grp.name = name
    face = grp.entities.add_face(polygon.map { |x, y| pt(x, y, z) })
    (holes || []).each do |hole|
      next if hole.length < 3
      begin
        inner = grp.entities.add_face(hole.map { |x, y| pt(x, y, z) })
        inner.erase! if inner && inner.valid?
      rescue StandardError
        next
      end
    end
    grp.entities.grep(Sketchup::Face).each do |f|
      f.reverse! if (f.normal.z < 0) == up
      f.material = mat
      f.back_material = mat
    end
    face = grp.entities.grep(Sketchup::Face).max_by(&:area)
    [grp, face]
  end

  def self.tag(model, name)
    model.layers[name] || model.layers.add(name)
  end

  def self.symbolize(hash)
    out = {}
    (hash || {}).each { |k, v| out[k.to_sym] = v }
    out
  end

  # 逐构件执行：一个构件失败只跳过它自己，错误连同构件名收集进 warnings。
  # 整段建模只有一个 rescue 的话，一根柱子报错就 abort_operation，前面建好的全丢；
  # 用户改一处再跑一轮，每轮还要点一次授权，代价远大于跳过并如实报告。
  # ents 给了时，失败的构件建了一半的组（半截墙、只有外轮廓的地面）一并删掉：留着的话 measure 会读到残缺的构件，
  # plan_verify 报一串尺寸不对，掩盖了真正的原因（这条警告）
  # 快照按 entityID 记，不按对象：to_a 每次返回的包装对象未必是同一个，用数组相减会把整棵 root 都判成「新增」。
  def self.attempt(warnings, label, ents = nil)
    before = nil
    if ents
      before = {}
      ents.each { |x| before[x.entityID] = true }
    end
    yield
  rescue StandardError => e
    ents.to_a.each { |x| x.erase! if x.valid? && !before[x.entityID] } if before
    warnings << "#{label} 建模失败：#{e.class}: #{e.message}"
    nil
  end

  # ---------------------------------------------------------------- 主入口

  # 建一层：墙体（含门窗洞口）、柱、地面 / 顶棚。floor[:z] 是这一层楼面的标高（mm）。
  def self.build_floor(root, floor, opts, mats, tags, warnings, counters)
    z = floor[:z].to_f
    plan = floor[:plan]
    storey_h = (plan.dig('storey', 'height') || 2800).to_f
    walls = plan['walls'] || []
    openings = (plan['openings'] || []).group_by { |o| o['wall'] }
    key = floor[:level].nil? ? nil : floor[:level].to_s
    suffix = floor[:name] ? " #{floor[:name]}" : ''

    walls.each do |w|
      attempt(warnings, "墙 #{w['id']}", root.entities) do
        sx, sy = w['start']
        ex, ey = w['end']
        len = Math.hypot(ex - sx, ey - sy)
        next warnings << "墙 #{w['id']} 长度为 0，已跳过" if len < 1
        d = [(ex - sx) / len, (ey - sy) / len]
        n = [-d[1], d[0]]
        t = w['thickness'].to_f
        h = (w['height'] || storey_h).to_f
        spans = w['column_spans'] || []

        wg = root.entities.add_group
        wg.name = "墙 #{w['id']}#{suffix}"
        wg.layer = tags[:wall]
        wg.set_attribute(DICT, 'kind', 'wall')
        wg.set_attribute(DICT, 'floor', key) if key
        wg.set_attribute(DICT, 'id', w['id'])
        wg.set_attribute(DICT, 'length', len)
        wg.set_attribute(DICT, 'thickness', t)
        wg.set_attribute(DICT, 'height', h)

        cursor = 0.0
        (openings[w['id']] || []).sort_by { |o| o['offset'].to_f }.each do |o|
          a = [[o['offset'].to_f, 0.0].max, len].min
          b = [[a + o['width'].to_f, 0.0].max, len].min
          sill = o['sill'].to_f
          head = [sill + o['height'].to_f, h].min
          if a < cursor - 1
            warnings << "洞口 #{o['id']} 与前一个洞口重叠，已按顺序拼接"
            a = cursor
          end
          solid_box(wg.entities, [sx, sy], d, n, cursor, a, z, z + h, t, mats[:wall], '墙段', spans) if a > cursor
          solid_box(wg.entities, [sx, sy], d, n, a, b, z, z + sill, t, mats[:wall], '窗台', spans) if sill > 1
          solid_box(wg.entities, [sx, sy], d, n, a, b, z + head, z + h, t, mats[:wall], '过梁', spans) if head < h - 1
          cursor = [cursor, b].max

          og = root.entities.add_group
          og.name = "#{o['type'] == 'window' ? '窗' : (o['type'] == 'door' ? '门' : '洞口')} #{o['id']}#{suffix}"
          og.layer = tags[:open]
          og.set_attribute(DICT, 'kind', o['type'])
          og.set_attribute(DICT, 'floor', key) if key
          og.set_attribute(DICT, 'id', o['id'])
          og.set_attribute(DICT, 'wall', w['id'])
          og.set_attribute(DICT, 'width', b - a)
          og.set_attribute(DICT, 'sill', sill)
          og.set_attribute(DICT, 'height', head - sill)
          case o['type']
          when 'window'
            if opts[:include_windows]
              f = 50.0
              wall_box(og.entities, [sx, sy], d, n, a, a + f, z + sill, z + head, 70, mats[:frame], '窗框')
              wall_box(og.entities, [sx, sy], d, n, b - f, b, z + sill, z + head, 70, mats[:frame], '窗框')
              wall_box(og.entities, [sx, sy], d, n, a, b, z + sill, z + sill + f, 70, mats[:frame], '窗框')
              wall_box(og.entities, [sx, sy], d, n, a, b, z + head - f, z + head, 70, mats[:frame], '窗框')
              wall_box(og.entities, [sx, sy], d, n, a + f, b - f, z + sill + f, z + head - f, 12, mats[:glass], '玻璃')
            end
          when 'door'
            if opts[:include_doors]
              if o['style'] == 'sliding'
                half_w = (b - a) / 2.0
                wall_box(og.entities, [sx, sy], d, n, a, a + half_w + 30, z, z + head - 20, 30, mats[:glass], '推拉门扇')
                wall_box(og.entities, [sx, sy], d, n, a + half_w - 30, b, z, z + head - 20, 30, mats[:glass], '推拉门扇')
              else
                wall_box(og.entities, [sx, sy], d, n, a + 20, b - 20, z, z + head - 10, 40, mats[:door], '门扇')
              end
            end
          end
          # 不生成门窗构件（或无门扇过道）时组会是空的，SketchUp 会自动删掉空组；放一个辅助点保住它，measure 才读得到
          og.entities.add_cpoint(pt(sx + d[0] * (a + b) / 2.0, sy + d[1] * (a + b) / 2.0, z + sill)) if og.entities.length.zero?
          counters[:openings] += 1
        end
        solid_box(wg.entities, [sx, sy], d, n, cursor, len, z, z + h, t, mats[:wall], '墙段', spans) if len > cursor + 1
        # 墙整段都在柱子里时组是空的，SketchUp 会删掉空组；放一个辅助点保住它，measure 才读得到
        wg.entities.add_cpoint(pt(sx, sy, z)) if wg.entities.length.zero?
      end
    end

    (plan['columns'] || []).each do |c|
      attempt(warnings, "柱 #{c['id']}", root.entities) do
        cx, cy = c['center']
        cg = column_box(root.entities, cx, cy, c['width'].to_f, c['depth'].to_f, z, z + (c['height'] || storey_h).to_f, mats[:column], "柱 #{c['id']}#{suffix}")
        next unless cg
        cg.layer = tags[:column]
        cg.set_attribute(DICT, 'kind', 'column')
        cg.set_attribute(DICT, 'floor', key) if key
        cg.set_attribute(DICT, 'id', c['id'])
        counters[:columns] += 1
      end
    end

    (plan['rooms'] || []).each do |room|
      attempt(warnings, "房间 #{room['id']}", root.entities) do
        poly = room['polygon'] || []
        next if poly.length < 3
        wet = room['name'].to_s =~ WET_ROOM
        stair = room['type'] == 'stair'
        # 楼梯间 / 电梯井是通高洞口：不是最底层就不铺地面，各层都不做顶棚
        if opts[:include_floors] && !(stair && !floor[:bottom])
          holes = (room['column_cuts'] || []).map { |cut| cut['polygon'] }
          fg, face = floor_face(root.entities, poly, z, wet ? mats[:floor_wet] : mats[:floor_dry], "地面 #{room['name']}#{suffix}", true, holes)
          fg.layer = tags[:floor]
          fg.set_attribute(DICT, 'kind', 'floor')
          fg.set_attribute(DICT, 'floor', key) if key
          fg.set_attribute(DICT, 'id', room['id'])
          fg.set_attribute(DICT, 'name', room['name'])
          area = (fg.entities.grep(Sketchup::Face).sum(&:area) * 0.00064516).round(2)
          counters[:rooms] << { id: room['id'], name: room['name'], area_m2: area, plan_area_m2: room['area_m2'] }
        end
        # 顶棚只做最上面一层：其他层的顶就是上一层的地面。上面一层是屋顶层（只有楼梯间、机房）时，
        # 屋顶层的地面盖不住本层，这一层也要做顶棚
        if opts[:include_ceilings] && !stair && (floor[:top] || floor[:below_roof])
          cg, _ = floor_face(root.entities, poly, z + storey_h, mats[:ceiling], "顶棚 #{room['name']}#{suffix}", false, (room['column_cuts'] || []).map { |cut| cut['polygon'] })
          cg.layer = tags[:ceil]
          cg.set_attribute(DICT, 'kind', 'ceiling')
          cg.set_attribute(DICT, 'floor', key) if key
          cg.set_attribute(DICT, 'id', room['id'])
        end
      end
    end
  end

  def self.build(plan_path, raw_opts = {})
    opts = {
      style: 'modern_minimal',
      preset_dir: nil,
      include_floors: true,
      include_ceilings: true,
      include_doors: true,
      include_windows: true,
      replace_existing: true,
      export_preview_path: nil,
      output_skp_path: nil
    }.merge(symbolize(raw_opts))

    model = Sketchup.active_model
    raise '未找到活动的 SketchUp 模型文档，请先新建或打开一个模型。' unless model
    plan = JSON.parse(File.read(plan_path.to_s, encoding: 'UTF-8'))
    schema = plan['schema'].to_s
    unless schema.start_with?('design-agent/plan@') || schema.start_with?('design-agent/building@')
      raise "不是 plan.json / building.json（schema=#{plan['schema']}）"
    end

    warnings = []
    floors =
      if schema.start_with?('design-agent/building@')
        (plan['floors'] || []).each_with_index.map do |f, index|
          { level: f['level'], name: f['name'], z: f['elevation'].to_f, bottom: index.zero?, roof: f['kind'] == 'roof', plan: f['plan'] || {} }
        end
      else
        [{ level: nil, name: nil, z: 0.0, bottom: true, plan: plan }]
      end
    raise 'building 文件里没有 floors' if floors.empty?
    floors.each_with_index do |f, index|
      f[:top] = index == floors.length - 1
      f[:below_roof] = !f[:roof] && floors[index + 1] && floors[index + 1][:roof] ? true : false
    end

    model.start_operation('DesignAgent Plan Build', true)
    begin
      if opts[:replace_existing]
        model.entities.grep(Sketchup::Group).select { |g| g.name == ROOT_NAME }.each { |g| g.erase! if g.valid? }
      end
      mats = build_materials(model, opts, warnings)
      tags = {
        wall: tag(model, 'DA_墙体'),
        open: tag(model, 'DA_门窗'),
        floor: tag(model, 'DA_地面'),
        ceil: tag(model, 'DA_顶棚'),
        column: tag(model, 'DA_柱')
      }

      root = model.entities.add_group
      root.name = ROOT_NAME
      root.set_attribute(DICT, 'plan', plan_path.to_s)
      root.set_attribute(DICT, 'version', VERSION)

      counters = { openings: 0, columns: 0, rooms: [] }
      floors.each do |floor|
        label = floor[:name] || (floor[:level] && "第 #{floor[:level]} 层") || '平面'
        attempt(warnings, "楼层 #{label}") { build_floor(root, floor, opts, mats, tags, warnings, counters) }
      end

      model.commit_operation

      exports = export_views(model, root, opts, warnings)
      bb = root.bounds
      JSON.generate(
        status: warnings.empty? ? 'ok' : 'partial_ok',
        builder: 'plan_builder',
        version: VERSION,
        plan: plan_path.to_s,
        floors: floors.length,
        walls: floors.sum { |f| (f[:plan]['walls'] || []).length },
        openings: counters[:openings],
        columns: counters[:columns],
        rooms: counters[:rooms],
        bounds_mm: { width: (bb.width * 25.4).round, depth: (bb.height * 25.4).round, height: (bb.depth * 25.4).round },
        preview_out: exports[:preview],
        skp_out: exports[:skp],
        warnings: warnings
      )
    rescue => e
      model.abort_operation
      JSON.generate(status: 'error', builder: 'plan_builder', error: "#{e.class}: #{e.message}", warnings: warnings)
    end
  end

  def self.export_views(model, root, opts, warnings)
    out = {}
    begin
      view = model.active_view
      bb = root.bounds
      center = bb.center
      eye = center.offset(Geom::Vector3d.new(-1, -1.2, 1.1), bb.diagonal * 1.1)
      view.camera = Sketchup::Camera.new(eye, center, Geom::Vector3d.new(0, 0, 1))
      view.zoom_extents
      pages = model.pages
      %w[DA_轴测 DA_俯视].each { |name| pages.erase(pages[name]) if pages[name] }
      pages.add('DA_轴测')
      top_eye = center.offset(Geom::Vector3d.new(0, 0, 1), bb.diagonal * 1.5)
      view.camera = Sketchup::Camera.new(top_eye, center, Geom::Vector3d.new(0, 1, 0))
      view.camera.perspective = false
      view.zoom_extents
      pages.add('DA_俯视')
      pages.selected_page = pages['DA_轴测']
      if opts[:export_preview_path]
        path = opts[:export_preview_path].to_s
        Dir.mkdir(File.dirname(path)) unless Dir.exist?(File.dirname(path))
        view.write_image(filename: path, width: 1600, height: 1000, antialias: true)
        out[:preview] = path
      end
      if opts[:output_skp_path]
        path = opts[:output_skp_path].to_s
        model.save_copy(path)
        out[:skp] = path
      end
    rescue => e
      warnings << "导出视图或文件失败：#{e.message}"
    end
    out
  end

  # ---------------------------------------------------------------- 核对用：读回已生成的模型

  # 返回 JSON：每段墙的长 / 厚 / 高、每个洞口的宽 / 窗台 / 高、每个房间地面的实测面积。
  # 由于墙段按洞口拆成了多块，墙长取墙组的属性值，同时给出墙组实际包围盒用于发现缺块。
  def self.measure
    model = Sketchup.active_model
    root = model && model.entities.grep(Sketchup::Group).find { |g| g.name == ROOT_NAME }
    return JSON.generate(status: 'error', error: '模型中没有 DesignAgentPlan_Root，请先执行 build') unless root

    buckets = {}
    root.entities.grep(Sketchup::Group).each do |g|
      kind = g.get_attribute(DICT, 'kind')
      next unless %w[wall window door passage floor column].include?(kind)
      key = g.get_attribute(DICT, 'floor')
      bucket = (buckets[key] ||= { level: key, walls: [], openings: [], rooms: [], columns: [], boxes: [] })
      bucket[:boxes] << g
      case kind
      when 'wall'
        volume = g.entities.grep(Sketchup::Group).sum { |piece| piece.manifold? ? piece.volume : 0 } * (25.4**3) / 1e9
        bucket[:walls] << {
          id: g.get_attribute(DICT, 'id'),
          length: g.get_attribute(DICT, 'length').to_f.round(1),
          thickness: g.get_attribute(DICT, 'thickness').to_f.round(1),
          height: (g.bounds.depth * 25.4).round(1),
          pieces: g.entities.grep(Sketchup::Group).length,
          volume_m3: volume.round(3)
        }
      when 'window', 'door', 'passage'
        bucket[:openings] << {
          id: g.get_attribute(DICT, 'id'),
          type: kind,
          wall: g.get_attribute(DICT, 'wall'),
          width: g.get_attribute(DICT, 'width').to_f.round(1),
          sill: g.get_attribute(DICT, 'sill').to_f.round(1),
          height: g.get_attribute(DICT, 'height').to_f.round(1)
        }
      when 'column'
        bucket[:columns] << {
          id: g.get_attribute(DICT, 'id'),
          width: (g.bounds.width * 25.4).round(1),
          depth: (g.bounds.height * 25.4).round(1),
          height: (g.bounds.depth * 25.4).round(1)
        }
      when 'floor'
        area = g.entities.grep(Sketchup::Face).sum(&:area) * 0.00064516
        bucket[:rooms] << { id: g.get_attribute(DICT, 'id'), name: g.get_attribute(DICT, 'name'), area_m2: area.round(2) }
      end
    end

    bb = root.bounds
    result = {
      status: 'ok',
      plan: root.get_attribute(DICT, 'plan'),
      bounds_mm: { width: (bb.width * 25.4).round, depth: (bb.height * 25.4).round, height: (bb.depth * 25.4).round }
    }
    if buckets.keys.all? { |k| k.nil? }
      flat = buckets[nil] || { walls: [], openings: [], rooms: [], columns: [] }
      result[:walls] = flat[:walls]
      result[:openings] = flat[:openings]
      result[:rooms] = flat[:rooms]
      result[:columns] = flat[:columns]
    else
      result[:floors] = buckets.map do |_key, b|
        xs = b[:boxes].flat_map { |g| [g.bounds.min.x, g.bounds.max.x] }
        ys = b[:boxes].flat_map { |g| [g.bounds.min.y, g.bounds.max.y] }
        {
          level: b[:level],
          walls: b[:walls],
          openings: b[:openings],
          rooms: b[:rooms],
          columns: b[:columns],
          bounds_mm: xs.empty? ? nil : { width: ((xs.max - xs.min) * 25.4).round, depth: ((ys.max - ys.min) * 25.4).round }
        }
      end
    end
    JSON.generate(result)
  end
end
