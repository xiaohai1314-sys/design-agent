# encoding: utf-8
# LivingRoomPreset - 住宅客厅参数化 SketchUp 入口脚本（确定性建模工程包）

require 'json'

module LivingRoomPreset
  PRESET_VERSION = '1.0.0'

  def self.mm(val)
    val.to_f / 25.4
  end

  def self.apply_material(entity, mat)
    return unless entity && mat
    entity.material = mat
    if entity.respond_to?(:entities)
      entity.entities.each do |sub|
        if sub.is_a?(Sketchup::Face)
          sub.material = mat
          sub.back_material = mat
        end
      end
    end
  end

  def self.add_box(ents, x_mm, y_mm, z_mm, w_mm, d_mm, h_mm, mat = nil, tag = nil, name = nil)
    return nil if w_mm.to_f <= 0 || d_mm.to_f <= 0 || h_mm.to_f <= 0
    grp = ents.add_group
    grp.name = name if name
    grp.layer = tag if tag && grp.respond_to?(:layer=)
    gents = grp.entities
    pts = [
      Geom::Point3d.new(mm(x_mm), mm(y_mm), mm(z_mm)),
      Geom::Point3d.new(mm(x_mm + w_mm), mm(y_mm), mm(z_mm)),
      Geom::Point3d.new(mm(x_mm + w_mm), mm(y_mm + d_mm), mm(z_mm)),
      Geom::Point3d.new(mm(x_mm), mm(y_mm + d_mm), mm(z_mm))
    ]
    face = gents.add_face(pts)
    if face
      face.reverse! if face.normal.z < 0
      face.pushpull(mm(h_mm))
      apply_material(grp, mat) if mat
    end
    grp
  end

  def self.normalize_options(raw_opts = {})
    opts = {}
    (raw_opts || {}).each { |k, v| opts[k.to_sym] = v }
    {
      width_mm: [[opts.fetch(:width_mm, 4800).to_f, 3200.0].max, 12000.0].min,
      depth_mm: [[opts.fetch(:depth_mm, 6400).to_f, 4000.0].max, 14000.0].min,
      height_mm: [[opts.fetch(:height_mm, 2900).to_f, 2400.0].max, 6000.0].min,
      wall_thickness_mm: [[opts.fetch(:wall_thickness_mm, 200).to_f, 100.0].max, 450.0].min,
      style: Finish.normalize_style(opts[:style] || 'modern_minimal'),
      include_balcony: opts.fetch(:include_balcony, true) ? true : false,
      include_furniture: opts.fetch(:include_furniture, true) ? true : false,
      include_decor: opts.fetch(:include_decor, true) ? true : false,
      replace_existing_preset: opts.fetch(:replace_existing_preset, true) ? true : false,
      export_preview_path: opts[:export_preview_path],
      output_skp_path: opts[:output_skp_path]
    }
  end

  def self.build(preset_dir = File.expand_path('..', __dir__), raw_opts = {})
    scripts_dir = File.join(preset_dir.to_s, 'scripts')
    %w[finish.rb architecture.rb furniture.rb decor.rb refine.rb].each do |sub|
      load File.join(scripts_dir, sub)
    end

    model = Sketchup.active_model
    raise '未找到活动的 SketchUp 模型文档，请先在 SketchUp 中新建或打开模型页。' unless model

    opts = normalize_options(raw_opts)
    errors = []

    model.start_operation('LivingRoomPreset Build', true)
    begin
      # 仅移除本预置包此前生成的同名总控组，严禁 entities.clear! 破坏用户已有设计内容
      if opts[:replace_existing_preset]
        old_groups = model.entities.grep(Sketchup::Group).select { |g| g.name == 'LivingRoomPreset_Root' }
        old_groups.each { |g| g.erase! if g.valid? }
      end

      tag_arch = model.layers.add('01_Architecture')
      tag_mill = model.layers.add('02_Millwork')
      tag_furn = model.layers.add('03_Furniture')
      tag_decor = model.layers.add('04_Decor')

      mats = Finish.build_materials(model, preset_dir, opts[:style], errors)

      root_grp = model.entities.add_group
      root_grp.name = 'LivingRoomPreset_Root'

      arch_grp = root_grp.entities.add_group
      arch_grp.name = 'LivingRoom_Architecture'
      arch_grp.layer = tag_arch

      mill_grp = root_grp.entities.add_group
      mill_grp.name = 'LivingRoom_Millwork'
      mill_grp.layer = tag_mill

      furn_grp = root_grp.entities.add_group
      furn_grp.name = 'LivingRoom_Furniture'
      furn_grp.layer = tag_furn

      decor_grp = root_grp.entities.add_group
      decor_grp.name = 'LivingRoom_Decor'
      decor_grp.layer = tag_decor

      Architecture.build(arch_grp, opts, mats, tag_arch, errors)
      Furniture.build(mill_grp, furn_grp, opts, mats, tag_mill, tag_furn, errors)
      Decor.build(decor_grp, opts, mats, tag_decor, errors)
      exports = Refine.apply(model, opts, errors)

      model.commit_operation

      JSON.generate(
        status: errors.empty? ? 'ok' : 'partial_ok',
        preset: 'living-room-modeling-v1',
        version: PRESET_VERSION,
        dimensions_mm: { width: opts[:width_mm], depth: opts[:depth_mm], height: opts[:height_mm] },
        style: opts[:style],
        groups_created: root_grp.entities.length,
        materials_count: mats.length,
        pages: model.pages.map(&:name),
        preview_out: exports[:preview_out],
        skp_out: exports[:skp_out],
        warnings: errors
      )
    rescue => e
      model.abort_operation
      JSON.generate(
        status: 'error',
        preset: 'living-room-modeling-v1',
        error: "#{e.class}: #{e.message}",
        warnings: errors
      )
    end
  end
end

module LivingRoomDemo
  def self.build(preset_dir = File.expand_path('..', __dir__), raw_opts = {})
    LivingRoomPreset.build(preset_dir, raw_opts)
  end
end
