# encoding: utf-8
# LivingRoomPreset - 灯光阴影、双机位相机场景与可选图片/SKP导出

module LivingRoomPreset
  module Refine
    def self.apply(model, opts, errors)
      w = opts[:width_mm]
      d = opts[:depth_mm]
      h = opts[:height_mm]

      # 1. 配置日照阴影与材质显示风格（遵循 SketchUp 规范：阴影属性位于 shadow_info）
      begin
        si = model.shadow_info
        si['DisplayShadows'] = true
        si['Light'] = 78
        si['Dark'] = 42
        si['UseSunForAllShading'] = false
      rescue => e
        errors << "shadow_info: #{e.message}"
      end

      begin
        ro = model.rendering_options
        ro['EdgeDisplayMode'] = true
        ro['DisplayProfiles'] = true
        ro['DrawBackEdges'] = false
      rescue => e
        errors << "rendering_options: #{e.message}"
      end

      # 2. 生成“客厅主视角”（由入户视角向阳台与电视主景望去）与“全景轴测图”两个场景页
      begin
        pages = model.pages
        view = model.active_view
        if view
          eye_main = Geom::Point3d.new(LivingRoomPreset.mm(w * 0.34), LivingRoomPreset.mm(420), LivingRoomPreset.mm(1380))
          target_main = Geom::Point3d.new(LivingRoomPreset.mm(w * 0.54), LivingRoomPreset.mm(d * 0.72), LivingRoomPreset.mm(1120))
          cam_main = Sketchup::Camera.new(eye_main, target_main, Geom::Vector3d.new(0, 0, 1))
          cam_main.focal_length = 26 if cam_main.respond_to?(:focal_length=)
          view.camera = cam_main

          existing_main = pages.find { |p| p.name == '客厅主视角' }
          if existing_main
            pages.selected_page = existing_main
            existing_main.update(127)
          else
            pages.add('客厅主视角')
          end

          eye_wide = Geom::Point3d.new(LivingRoomPreset.mm(w * 0.85), LivingRoomPreset.mm(-1400), LivingRoomPreset.mm(h * 0.92))
          target_wide = Geom::Point3d.new(LivingRoomPreset.mm(w * 0.42), LivingRoomPreset.mm(d * 0.55), LivingRoomPreset.mm(950))
          cam_wide = Sketchup::Camera.new(eye_wide, target_wide, Geom::Vector3d.new(0, 0, 1))
          cam_wide.focal_length = 24 if cam_wide.respond_to?(:focal_length=)
          view.camera = cam_wide

          existing_wide = pages.find { |p| p.name == '全景俯瞰' }
          if existing_wide
            pages.selected_page = existing_wide
            existing_wide.update(127)
          else
            pages.add('全景俯瞰')
          end

          # 回到“客厅主视角”并强制刷新视图
          main_page = pages.find { |p| p.name == '客厅主视角' }
          pages.selected_page = main_page if main_page
          view.camera = cam_main
          view.invalidate
        end
      rescue => e
        errors << "camera_pages: #{e.message}"
      end

      # 3. 可选导出预览截图与 .skp 模型文件
      preview_out = nil
      skp_out = nil

      if opts[:export_preview_path] && !opts[:export_preview_path].to_s.strip.empty?
        begin
          view = model.active_view
          if view
            view.write_image(
              filename: opts[:export_preview_path].to_s,
              width: 1440,
              height: 900,
              antialias: true,
              transparent: false
            )
            preview_out = opts[:export_preview_path].to_s
          end
        rescue => e
          errors << "export_preview: #{e.message}"
        end
      end

      if opts[:output_skp_path] && !opts[:output_skp_path].to_s.strip.empty?
        begin
          model.save(opts[:output_skp_path].to_s)
          skp_out = opts[:output_skp_path].to_s
        rescue => e
          errors << "save_skp: #{e.message}"
        end
      end

      { preview_out: preview_out, skp_out: skp_out }
    end
  end
end
